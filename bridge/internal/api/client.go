// Package api talks to a Mail App install over its API (docs/api.md in this repository), with an API key.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Client is one Mail App install, reached with one API key.
type Client struct {
	Base string // https://mail.example.com (no /api/ext/v1)
	Key  string
	HTTP *http.Client
	// UserAgent is sent with every request.
	UserAgent string
}

// New makes a client for an install's web address and an API key.
func New(base, key, version string) *Client {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if base != "" && !strings.Contains(base, "://") {
		base = "https://" + base
	}
	base = strings.TrimSuffix(base, "/api/ext/v1")
	return &Client{
		Base: base, Key: strings.TrimSpace(key),
		HTTP:      &http.Client{Timeout: 2 * time.Minute},
		UserAgent: "Mail-App-Bridge/" + version,
	}
}

// Error is an answer from Mail App that wasn't a success.
type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("Mail App answered %d", e.Status)
	}
	return e.Message
}

// StatusOf is the HTTP status of an API error, or 0 for anything else (such as no connection).
func StatusOf(err error) int {
	var e *Error
	if errors.As(err, &e) {
		return e.Status
	}
	return 0
}

func (c *Client) mailboxPath(mailbox string) string {
	return "/mailboxes/" + url.PathEscape(strings.ToLower(mailbox))
}

func (c *Client) do(ctx context.Context, method, path string, query url.Values, body io.Reader, contentType string) (*http.Response, error) {
	u := c.Base + "/api/ext/v1" + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Key)
	req.Header.Set("User-Agent", c.UserAgent)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		defer res.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 64*1024))
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(raw, &e)
		return nil, &Error{Status: res.StatusCode, Message: e.Error}
	}
	return res, nil
}

func (c *Client) json(ctx context.Context, method, path string, query url.Values, in, out any) error {
	var body io.Reader
	ct := ""
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body, ct = bytes.NewReader(b), "application/json"
	}
	res, err := c.do(ctx, method, path, query, body, ct)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if out == nil {
		_, _ = io.Copy(io.Discard, res.Body)
		return nil
	}
	return json.NewDecoder(res.Body).Decode(out)
}

// Mailbox is one mailbox the key can use.
type Mailbox struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
}

// Mailboxes lists the mailboxes this key can use.
func (c *Client) Mailboxes(ctx context.Context) ([]Mailbox, error) {
	var out []Mailbox
	if err := c.json(ctx, "GET", "/mailboxes", nil, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Folder is one of a mailbox's folders.
type Folder struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Unread int    `json:"unreadCount"`
}

// Change is what happened to one email.
type Change struct {
	ID      string  `json:"id"`
	Folder  *string `json:"folder"`
	Read    bool    `json:"read"`
	Starred bool    `json:"starred"`
	Deleted bool    `json:"deleted"`
}

// Changes is one answer from the changes feed.
type Changes struct {
	Cursor  int64    `json:"cursor"`
	Changes []Change `json:"changes"`
	More    bool     `json:"more"`
	Folders []Folder `json:"folders"`
}

// ErrResync means the cursor is too old: read every folder again.
var ErrResync = errors.New("the change number is too old, starting again")

// Changes asks what changed since a change number. since < 0 asks just for the current number.
func (c *Client) Changes(ctx context.Context, mailbox string, since int64) (*Changes, error) {
	q := url.Values{}
	if since >= 0 {
		q.Set("since", fmt.Sprint(since))
	}
	var out Changes
	err := c.json(ctx, "GET", c.mailboxPath(mailbox)+"/changes", q, nil, &out)
	if StatusOf(err) == http.StatusGone {
		return nil, ErrResync
	}
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// IndexEntry is one email in a folder's list.
type IndexEntry struct {
	ID        string  `json:"id"`
	Read      bool    `json:"read"`
	Starred   bool    `json:"starred"`
	Date      *string `json:"date"`
	MessageID *string `json:"message_id"`
}

// Index lists every email in a folder, oldest first, and the change number it's good from.
func (c *Client) Index(ctx context.Context, mailbox, folder string) ([]IndexEntry, int64, error) {
	var all []IndexEntry
	var cursor int64 = -1
	for offset := 0; ; {
		q := url.Values{"folder": {folder}, "offset": {fmt.Sprint(offset)}}
		var page struct {
			Emails []IndexEntry `json:"emails"`
			More   bool         `json:"more"`
			Cursor int64        `json:"cursor"`
		}
		if err := c.json(ctx, "GET", c.mailboxPath(mailbox)+"/index", q, nil, &page); err != nil {
			return nil, 0, err
		}
		if cursor < 0 {
			cursor = page.Cursor
		}
		all = append(all, page.Emails...)
		offset += len(page.Emails)
		if !page.More || len(page.Emails) == 0 {
			break
		}
	}
	return all, cursor, nil
}

// Raw downloads an email as a standard email file.
func (c *Client) Raw(ctx context.Context, mailbox, id string) ([]byte, error) {
	res, err := c.do(ctx, "GET", c.mailboxPath(mailbox)+"/emails/"+url.PathEscape(id)+"/raw", nil, nil, "")
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	return io.ReadAll(res.Body)
}

// SetFlags marks an email read or unread, starred or not. nil leaves one as it is.
func (c *Client) SetFlags(ctx context.Context, mailbox, id string, read, starred *bool) error {
	body := map[string]bool{}
	if read != nil {
		body["read"] = *read
	}
	if starred != nil {
		body["starred"] = *starred
	}
	return c.json(ctx, "PUT", c.mailboxPath(mailbox)+"/emails/"+url.PathEscape(id), nil, body, nil)
}

// Move moves an email to a folder.
func (c *Client) Move(ctx context.Context, mailbox, id, folder string) error {
	return c.json(ctx, "POST", c.mailboxPath(mailbox)+"/emails/"+url.PathEscape(id)+"/move", nil, map[string]string{"folderId": folder}, nil)
}

// Delete deletes an email for good. Mail App only allows it for email in the Bin or Spam.
func (c *Client) Delete(ctx context.Context, mailbox, id string) error {
	return c.json(ctx, "DELETE", c.mailboxPath(mailbox)+"/emails/"+url.PathEscape(id), nil, nil, nil)
}

// Append adds an email file to a folder as it is, and answers its new id.
func (c *Client) Append(ctx context.Context, mailbox, folder string, raw []byte, read, starred bool) (string, error) {
	q := url.Values{"folder": {folder}, "read": {b01(read)}, "starred": {b01(starred)}}
	res, err := c.do(ctx, "POST", c.mailboxPath(mailbox)+"/append", q, bytes.NewReader(raw), "message/rfc822")
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var out struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return "", err
	}
	return out.ID, nil
}

func b01(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

// CreateFolder adds a folder and answers it.
func (c *Client) CreateFolder(ctx context.Context, mailbox, name string) (*Folder, error) {
	var out Folder
	if err := c.json(ctx, "POST", c.mailboxPath(mailbox)+"/folders", nil, map[string]string{"name": name}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RenameFolder renames a folder.
func (c *Client) RenameFolder(ctx context.Context, mailbox, id, name string) error {
	return c.json(ctx, "PUT", c.mailboxPath(mailbox)+"/folders/"+url.PathEscape(id), nil, map[string]string{"name": name}, nil)
}

// Attachment is a file sent with an email.
type Attachment struct {
	Content     string `json:"content"` // base64
	Filename    string `json:"filename"`
	Type        string `json:"type"`
	Disposition string `json:"disposition"` // attachment or inline
	ContentID   string `json:"contentId,omitempty"`
}

// From is who an email is from.
type From struct {
	Email string `json:"email"`
	Name  string `json:"name"`
}

// Send is a new email to send.
type Send struct {
	From        From         `json:"from"`
	To          []string     `json:"to"`
	Cc          []string     `json:"cc,omitempty"`
	Bcc         []string     `json:"bcc,omitempty"`
	Subject     string       `json:"subject"`
	HTML        string       `json:"html,omitempty"`
	Text        string       `json:"text,omitempty"`
	Attachments []Attachment `json:"attachments,omitempty"`
	InReplyTo   string       `json:"in_reply_to,omitempty"`
	References  []string     `json:"references,omitempty"`
}

// SendEmail sends an email from a mailbox, and answers its id.
func (c *Client) SendEmail(ctx context.Context, mailbox string, m *Send) (string, error) {
	var out struct {
		ID string `json:"id"`
	}
	if err := c.json(ctx, "POST", c.mailboxPath(mailbox)+"/emails", nil, m, &out); err != nil {
		return "", err
	}
	return out.ID, nil
}
