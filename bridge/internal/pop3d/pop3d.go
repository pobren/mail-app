// Package pop3d serves each mailbox's Inbox over POP3 (RFC 1939), on this computer only.
package pop3d

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"log"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/pobren/mail-app/bridge/internal/store"
)

// Accounts finds the account for a sign-in, or nil when the name or password is wrong.
type Accounts func(username, password string) *store.Account

// Options are the POP3 choices on the settings page.
type Options struct {
	// KeepMail: when Outlook deletes mail over POP3, leave it in Mail App. On by default.
	KeepMail func() bool
	// MarkRead: mark mail as read in Mail App once Outlook has downloaded it.
	MarkRead func() bool
}

// Serve answers POP3 on the listener until it's closed.
func Serve(ln net.Listener, accounts Accounts, opts Options) error {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return err
		}
		go handle(conn, accounts, opts)
	}
}

type item struct {
	id   string
	seen bool
	raw  []byte
	size int64
	dele bool
}

type conn struct {
	c     net.Conn
	r     *bufio.Reader
	w     *bufio.Writer
	acct  *store.Account
	items []*item
	opts  Options
}

func (c *conn) line(s string) {
	c.w.WriteString(s + "\r\n")
	c.w.Flush()
}
func (c *conn) ok(s string)  { c.line("+OK " + s) }
func (c *conn) err(s string) { c.line("-ERR " + s) }

func ctx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 2*time.Minute)
}

func handle(nc net.Conn, accounts Accounts, opts Options) {
	defer nc.Close()
	c := &conn{c: nc, r: bufio.NewReader(nc), w: bufio.NewWriter(nc), opts: opts}
	c.ok("Mail App bridge POP3 ready")
	var user string
	for {
		_ = nc.SetReadDeadline(time.Now().Add(10 * time.Minute))
		text, err := c.r.ReadString('\n')
		if err != nil {
			return
		}
		text = strings.TrimRight(text, "\r\n")
		cmd, arg, _ := strings.Cut(text, " ")
		cmd = strings.ToUpper(cmd)
		if c.acct == nil {
			switch cmd {
			case "CAPA":
				c.ok("Capability list follows")
				c.multi([]string{"USER", "UIDL", "TOP", "RESP-CODES", "AUTH-RESP-CODE", "IMPLEMENTATION Mail-App-Bridge"})
			case "USER":
				user = strings.TrimSpace(arg)
				c.ok("Now your password")
			case "PASS":
				a := accounts(user, arg)
				if a == nil {
					c.err("[AUTH] That email address or bridge password isn't right")
					continue
				}
				if err := c.load(a); err != nil {
					c.err("[SYS/TEMP] Couldn't reach Mail App: " + err.Error())
					continue
				}
				c.acct = a
				c.ok(fmt.Sprintf("%d messages", len(c.items)))
			case "QUIT":
				c.ok("Bye")
				return
			case "AUTH":
				c.err("Use USER and PASS")
			default:
				c.err("Sign in first")
			}
			continue
		}
		switch cmd {
		case "STAT":
			n, size := 0, int64(0)
			for _, it := range c.items {
				if !it.dele {
					n++
					size += c.size(it)
				}
			}
			c.ok(fmt.Sprintf("%d %d", n, size))
		case "LIST", "UIDL":
			if arg != "" {
				it, n := c.item(arg)
				if it == nil {
					c.err("No such message")
					continue
				}
				if cmd == "LIST" {
					c.ok(fmt.Sprintf("%d %d", n, c.size(it)))
				} else {
					c.ok(fmt.Sprintf("%d %s", n, it.id))
				}
				continue
			}
			c.ok("List follows")
			var lines []string
			for i, it := range c.items {
				if it.dele {
					continue
				}
				if cmd == "LIST" {
					lines = append(lines, fmt.Sprintf("%d %d", i+1, c.size(it)))
				} else {
					lines = append(lines, fmt.Sprintf("%d %s", i+1, it.id))
				}
			}
			c.multi(lines)
		case "RETR", "TOP":
			num, rest, _ := strings.Cut(arg, " ")
			it, _ := c.item(num)
			if it == nil {
				c.err("No such message")
				continue
			}
			raw, err := c.raw(it)
			if err != nil {
				c.err("Couldn't download it from Mail App: " + err.Error())
				continue
			}
			if cmd == "TOP" {
				n, err := strconv.Atoi(strings.TrimSpace(rest))
				if err != nil || n < 0 {
					c.err("TOP needs a message and a number of lines")
					continue
				}
				raw = top(raw, n)
			} else if c.opts.MarkRead != nil && c.opts.MarkRead() && !it.seen {
				read := true
				cx, cancel := ctx()
				if err := c.acct.Client().SetFlags(cx, c.acct.Address, it.id, &read, nil); err == nil {
					it.seen = true
				}
				cancel()
			}
			c.ok(fmt.Sprintf("%d octets", len(raw)))
			c.dot(raw)
		case "DELE":
			it, _ := c.item(arg)
			if it == nil {
				c.err("No such message")
				continue
			}
			it.dele = true
			c.ok("Marked to delete")
		case "RSET":
			for _, it := range c.items {
				it.dele = false
			}
			c.ok("Nothing will be deleted")
		case "NOOP":
			c.ok("")
		case "CAPA":
			c.ok("Capability list follows")
			c.multi([]string{"USER", "UIDL", "TOP", "RESP-CODES", "AUTH-RESP-CODE", "IMPLEMENTATION Mail-App-Bridge"})
		case "QUIT":
			c.commit()
			c.ok("Bye")
			return
		default:
			c.err("Unknown command")
		}
	}
}

// load takes a snapshot of the Inbox, oldest first, as POP3 numbers mail for the whole session.
func (c *conn) load(a *store.Account) error {
	cx, cancel := ctx()
	defer cancel()
	_ = a.SyncOnce(cx)
	a.Mu.Lock()
	defer a.Mu.Unlock()
	f := a.Folders[store.Inbox]
	if f == nil {
		return fmt.Errorf("the Inbox isn't ready yet, try again in a moment")
	}
	c.items = nil
	for _, m := range f.Msgs {
		if m.MovedAway || m.HasLocal("\\Deleted") {
			continue
		}
		c.items = append(c.items, &item{id: m.ID, seen: m.Seen, size: -1})
	}
	return nil
}

func (c *conn) item(arg string) (*item, int) {
	n, err := strconv.Atoi(strings.TrimSpace(arg))
	if err != nil || n < 1 || n > len(c.items) || c.items[n-1].dele {
		return nil, 0
	}
	return c.items[n-1], n
}

func (c *conn) raw(it *item) ([]byte, error) {
	if it.raw != nil {
		return it.raw, nil
	}
	cx, cancel := ctx()
	defer cancel()
	b, err := c.acct.Raw(cx, it.id)
	if err != nil {
		return nil, err
	}
	it.raw, it.size = b, int64(len(b))
	return b, nil
}

// size is the exact size POP3 needs, downloading the email if it isn't cached yet.
func (c *conn) size(it *item) int64 {
	if it.size >= 0 {
		return it.size
	}
	if n := c.acct.CachedSize(it.id); n >= 0 {
		it.size = n
		return n
	}
	if _, err := c.raw(it); err != nil {
		return 0
	}
	return it.size
}

func (c *conn) multi(lines []string) {
	for _, l := range lines {
		if strings.HasPrefix(l, ".") {
			l = "." + l
		}
		c.w.WriteString(l + "\r\n")
	}
	c.w.WriteString(".\r\n")
	c.w.Flush()
}

// dot sends an email with dot-stuffing and the closing dot.
func (c *conn) dot(raw []byte) {
	for _, l := range bytes.SplitAfter(raw, []byte("\n")) {
		if len(l) == 0 {
			continue
		}
		if l[0] == '.' {
			c.w.WriteByte('.')
		}
		c.w.Write(l)
	}
	if len(raw) > 0 && raw[len(raw)-1] != '\n' {
		c.w.WriteString("\r\n")
	}
	c.w.WriteString(".\r\n")
	c.w.Flush()
}

// top is the headers, the blank line, and the first n lines of the body.
func top(raw []byte, n int) []byte {
	i := bytes.Index(raw, []byte("\r\n\r\n"))
	if i < 0 {
		return raw
	}
	out := append([]byte{}, raw[:i+4]...)
	body := raw[i+4:]
	for k := 0; k < n && len(body) > 0; k++ {
		j := bytes.IndexByte(body, '\n')
		if j < 0 {
			out = append(out, body...)
			break
		}
		out = append(out, body[:j+1]...)
		body = body[j+1:]
	}
	return out
}

// commit carries out the deletes at QUIT: mail goes to Mail App's Bin, unless "keep mail" is on.
func (c *conn) commit() {
	if c.opts.KeepMail == nil || c.opts.KeepMail() {
		return
	}
	cx, cancel := ctx()
	defer cancel()
	for _, it := range c.items {
		if !it.dele {
			continue
		}
		if err := c.acct.Client().Move(cx, c.acct.Address, it.id, store.Bin); err != nil {
			log.Printf("%s: POP3 delete of %s: %v", c.acct.Address, it.id, err)
		}
	}
	c.acct.Poke()
}
