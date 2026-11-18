// Package smtpd takes the mail Outlook sends, on this computer only, and sends it through Mail App's API,
// so it goes out from Mail App and shows in its Sent folder.
package smtpd

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"strings"
	"time"

	"github.com/emersion/go-message"
	_ "github.com/emersion/go-message/charset"
	"github.com/emersion/go-message/mail"
	"github.com/emersion/go-sasl"
	"github.com/emersion/go-smtp"
	"github.com/pobren/mail-app/bridge/internal/api"
	"github.com/pobren/mail-app/bridge/internal/store"
)

// Accounts finds the account for a sign-in, or nil when the name or password is wrong.
type Accounts func(username, password string) *store.Account

// MaxBytes is the most Outlook may send in one email. Mail App's own limit (5 MB once encoded) is checked there.
const MaxBytes = 25 * 1024 * 1024

// Serve answers SMTP on the listener until it's closed.
func Serve(ln net.Listener, accounts Accounts) error {
	s := smtp.NewServer(smtp.BackendFunc(func(*smtp.Conn) (smtp.Session, error) {
		return &session{accounts: accounts}, nil
	}))
	s.Domain = "localhost"
	s.AllowInsecureAuth = true // only this computer can connect
	s.MaxMessageBytes = MaxBytes
	s.MaxRecipients = 100
	s.ReadTimeout = 5 * time.Minute
	s.WriteTimeout = 5 * time.Minute
	return s.Serve(ln)
}

type session struct {
	accounts Accounts
	acct     *store.Account
	from     string
	rcpts    []string
}

var _ smtp.AuthSession = (*session)(nil)

var errAuth = &smtp.SMTPError{Code: 535, EnhancedCode: smtp.EnhancedCode{5, 7, 8}, Message: "That email address or bridge password isn't right"}

func (s *session) AuthMechanisms() []string { return []string{sasl.Plain, sasl.Login} }

func (s *session) Auth(mech string) (sasl.Server, error) {
	check := func(user, pass string) error {
		a := s.accounts(user, pass)
		if a == nil {
			return errAuth
		}
		s.acct = a
		return nil
	}
	switch mech {
	case sasl.Plain:
		return sasl.NewPlainServer(func(_, user, pass string) error { return check(user, pass) }), nil
	case sasl.Login:
		return &loginServer{check: check}, nil
	}
	return nil, smtp.ErrAuthUnsupported
}

// loginServer is the old AUTH LOGIN, which Outlook still likes to use.
type loginServer struct {
	step int
	user string
	check func(user, pass string) error
}

func (l *loginServer) Next(response []byte) ([]byte, bool, error) {
	switch l.step {
	case 0:
		l.step = 1
		if len(response) > 0 { // initial response carries the user name
			l.user, l.step = string(response), 2
			return []byte("Password:"), false, nil
		}
		return []byte("Username:"), false, nil
	case 1:
		l.user, l.step = string(response), 2
		return []byte("Password:"), false, nil
	default:
		return nil, true, l.check(l.user, string(response))
	}
}

func (s *session) Mail(from string, _ *smtp.MailOptions) error {
	if s.acct == nil {
		return smtp.ErrAuthRequired
	}
	s.from = from
	return nil
}

func (s *session) Rcpt(to string, _ *smtp.RcptOptions) error {
	if s.acct == nil {
		return smtp.ErrAuthRequired
	}
	s.rcpts = append(s.rcpts, strings.ToLower(strings.TrimSpace(to)))
	return nil
}

func (s *session) Reset()        { s.from, s.rcpts = "", nil }
func (s *session) Logout() error { return nil }

func (s *session) Data(r io.Reader) error {
	if s.acct == nil {
		return smtp.ErrAuthRequired
	}
	raw, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	m, msgID, err := Build(raw, s.from, s.rcpts)
	if err != nil {
		return &smtp.SMTPError{Code: 554, EnhancedCode: smtp.EnhancedCode{5, 6, 0}, Message: err.Error()}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	id, err := s.acct.Client().SendEmail(ctx, s.acct.Address, m)
	if err != nil {
		log.Printf("%s: sending failed: %v", s.acct.Address, err)
		code, enh := 451, smtp.EnhancedCode{4, 3, 0}
		switch api.StatusOf(err) {
		case 400, 403, 404:
			code, enh = 550, smtp.EnhancedCode{5, 7, 1}
		case 413:
			code, enh = 552, smtp.EnhancedCode{5, 3, 4}
		case 502:
			code, enh = 554, smtp.EnhancedCode{5, 0, 0}
		}
		return &smtp.SMTPError{Code: code, EnhancedCode: enh, Message: "Mail App: " + err.Error()}
	}
	if msgID != "" {
		s.acct.NoteSent(msgID, id)
	}
	return nil
}

// Build turns the email Outlook sent into a send request for Mail App's API. Bcc is everyone in the SMTP
// envelope who isn't in To or Cc.
func Build(raw []byte, envelopeFrom string, rcpts []string) (*api.Send, string, error) {
	mr, err := mail.CreateReader(bytes.NewReader(raw))
	if err != nil && !message.IsUnknownCharset(err) {
		return nil, "", fmt.Errorf("couldn't read the email: %v", err)
	}
	h := mr.Header
	out := &api.Send{}
	if from, err := h.AddressList("From"); err == nil && len(from) > 0 {
		out.From = api.From{Email: strings.ToLower(from[0].Address), Name: from[0].Name}
	} else if envelopeFrom != "" {
		out.From = api.From{Email: strings.ToLower(envelopeFrom)}
	} else {
		return nil, "", errors.New("the email has no From address")
	}
	named := map[string]bool{}
	list := func(key string) []string {
		addrs, _ := h.AddressList(key)
		var l []string
		for _, a := range addrs {
			e := strings.ToLower(a.Address)
			named[e] = true
			l = append(l, e)
		}
		return l
	}
	out.To, out.Cc = list("To"), list("Cc")
	for _, r := range rcpts {
		if !named[r] {
			out.Bcc = append(out.Bcc, r)
			named[r] = true
		}
	}
	if len(out.To) == 0 {
		if len(out.Cc) > 0 {
			out.To, out.Cc = out.Cc, nil
		} else if len(out.Bcc) > 0 {
			out.To, out.Bcc = out.Bcc[:1], out.Bcc[1:]
		} else {
			return nil, "", errors.New("the email has nobody to send to")
		}
	}
	out.Subject, _ = h.Subject()
	if ids, err := h.MsgIDList("In-Reply-To"); err == nil && len(ids) > 0 {
		out.InReplyTo = ids[0]
	}
	if ids, err := h.MsgIDList("References"); err == nil {
		out.References = ids
	}
	msgID, _ := h.MessageID()

	for {
		p, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil && !message.IsUnknownCharset(err) {
			return nil, "", fmt.Errorf("couldn't read part of the email: %v", err)
		}
		if p == nil {
			break
		}
		body, err := io.ReadAll(p.Body)
		if err != nil {
			return nil, "", fmt.Errorf("couldn't read part of the email: %v", err)
		}
		switch ph := p.Header.(type) {
		case *mail.InlineHeader:
			ct, params, _ := ph.ContentType()
			cid := strings.Trim(ph.Get("Content-Id"), "<> ")
			switch {
			case ct == "text/plain" && out.Text == "" && cid == "":
				out.Text = string(body)
			case ct == "text/html" && out.HTML == "" && cid == "":
				out.HTML = string(body)
			default:
				name := params["name"]
				if name == "" {
					name = "part" + extFor(ct)
				}
				out.Attachments = append(out.Attachments, api.Attachment{
					Content: base64.StdEncoding.EncodeToString(body), Filename: name, Type: orOctet(ct),
					Disposition: "inline", ContentID: cid,
				})
			}
		case *mail.AttachmentHeader:
			name, _ := ph.Filename()
			ct, _, _ := ph.ContentType()
			if name == "" {
				name = "attachment" + extFor(ct)
			}
			disp := "attachment"
			cid := strings.Trim(ph.Get("Content-Id"), "<> ")
			if d, _, _ := ph.ContentDisposition(); d == "inline" && cid != "" {
				disp = "inline"
			}
			out.Attachments = append(out.Attachments, api.Attachment{
				Content: base64.StdEncoding.EncodeToString(body), Filename: name, Type: orOctet(ct),
				Disposition: disp, ContentID: cid,
			})
		}
	}
	if out.HTML == "" && out.Text == "" {
		out.Text = " "
	}
	return out, msgID, nil
}

func orOctet(ct string) string {
	if ct == "" {
		return "application/octet-stream"
	}
	return ct
}

func extFor(ct string) string {
	if exts, _ := mime.ExtensionsByType(ct); len(exts) > 0 {
		return exts[0]
	}
	return ".bin"
}
