// Package bridge runs the whole bridge: the accounts kept in step with Mail App, and the IMAP, POP3 and
// SMTP servers Outlook connects to, all on this computer only (127.0.0.1).
package bridge

import (
	"context"
	"crypto/subtle"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/pobren/mail-app/bridge/internal/api"
	"github.com/pobren/mail-app/bridge/internal/config"
	"github.com/pobren/mail-app/bridge/internal/imapd"
	"github.com/pobren/mail-app/bridge/internal/pop3d"
	"github.com/pobren/mail-app/bridge/internal/smtpd"
	"github.com/pobren/mail-app/bridge/internal/store"
)

// Version is set when the bridge is built.
var Version = "dev"

// Bridge is the running bridge.
type Bridge struct {
	Settings *config.Store
	cacheDir string

	mu       sync.Mutex
	accounts map[string]*store.Account
	cancel   context.CancelFunc
	problem  string
	servers  []net.Listener
	listenOK map[string]string // "IMAP" -> problem, if the port couldn't be used
}

// New makes a bridge from its settings.
func New(settings *config.Store, cacheDir string) *Bridge {
	return &Bridge{Settings: settings, cacheDir: cacheDir, accounts: map[string]*store.Account{}, listenOK: map[string]string{}}
}

// Account finds the account for a sign-in from Outlook, or nil.
func (b *Bridge) Account(username, password string) *store.Account {
	cfg := b.Settings.Get()
	if subtle.ConstantTimeCompare([]byte(strings.TrimSpace(password)), []byte(cfg.Password)) != 1 {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.accounts[strings.ToLower(strings.TrimSpace(username))]
}

// Accounts lists the mailboxes the bridge serves.
func (b *Bridge) Accounts() []*store.Account {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []*store.Account
	for _, a := range b.accounts {
		out = append(out, a)
	}
	return out
}

// Problem is what stopped the bridge connecting to Mail App, if anything.
func (b *Bridge) Problem() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.problem
}

// PortProblems says which servers couldn't start, and why.
func (b *Bridge) PortProblems() map[string]string {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := map[string]string{}
	for k, v := range b.listenOK {
		out[k] = v
	}
	return out
}

// Listen starts the IMAP, POP3 and SMTP servers on 127.0.0.1.
func (b *Bridge) Listen() {
	cfg := b.Settings.Get()
	start := func(name string, port int, serve func(net.Listener) error) {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			b.mu.Lock()
			b.listenOK[name] = fmt.Sprintf("Port %d is in use by another program", port)
			b.mu.Unlock()
			log.Printf("%s: %v", name, err)
			return
		}
		b.mu.Lock()
		b.servers = append(b.servers, ln)
		b.mu.Unlock()
		go func() {
			if err := serve(ln); err != nil && !strings.Contains(err.Error(), "closed") {
				log.Printf("%s stopped: %v", name, err)
			}
		}()
	}
	start("IMAP", cfg.IMAPPort, func(ln net.Listener) error { return imapd.Serve(ln, b.Account, debugWriter()) })
	start("POP3", cfg.POP3Port, func(ln net.Listener) error {
		return pop3d.Serve(ln, b.Account, pop3d.Options{
			KeepMail: func() bool { return b.Settings.Get().KeepMail },
			MarkRead: func() bool { return b.Settings.Get().MarkRead },
		})
	})
	start("SMTP", cfg.SMTPPort, func(ln net.Listener) error { return smtpd.Serve(ln, b.Account) })
}

// Close stops everything.
func (b *Bridge) Close() {
	b.mu.Lock()
	for _, ln := range b.servers {
		_ = ln.Close()
	}
	cancel := b.cancel
	accts := b.accounts
	b.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	for _, a := range accts {
		_ = a.Save()
	}
}

// debugWriter shows every IMAP command when MAILAPP_BRIDGE_DEBUG is set. (A nil io.Writer, not a nil
// *os.File, so the IMAP server sees there's nothing to write to.)
func debugWriter() io.Writer {
	if os.Getenv("MAILAPP_BRIDGE_DEBUG") != "" {
		return os.Stderr
	}
	return nil
}

// Connect checks the saved Mail App address and key, and starts keeping each mailbox in step.
func (b *Bridge) Connect(ctx context.Context) error {
	cfg := b.Settings.Get()
	b.mu.Lock()
	if b.cancel != nil {
		b.cancel()
		b.cancel = nil
	}
	b.mu.Unlock()
	if cfg.Server == "" || cfg.Key == "" {
		b.setProblem("Add your Mail App web address and API key to start.")
		return nil
	}
	client := api.New(cfg.Server, cfg.Key, Version)
	c, cancel := context.WithTimeout(ctx, 30*time.Second)
	boxes, err := client.Mailboxes(c)
	cancel()
	if err != nil {
		msg := err.Error()
		if api.StatusOf(err) == 0 {
			msg = "Couldn't reach Mail App at " + client.Base + ". Check the web address and your internet connection."
		}
		b.setProblem(msg)
		return err
	}
	if len(boxes) == 0 {
		b.setProblem("This API key can't use any mailboxes. Make a key in Mail App that ticks your mailbox.")
		return nil
	}
	runCtx, runCancel := context.WithCancel(context.Background())
	accts := map[string]*store.Account{}
	for _, m := range boxes {
		addr := strings.ToLower(m.Email)
		if addr == "" {
			addr = strings.ToLower(m.ID)
		}
		dir := filepath.Join(b.cacheDir, "mailboxes", safeName(client.Base+"_"+addr))
		a, err := store.New(addr, client, dir)
		if err != nil {
			runCancel()
			b.setProblem(err.Error())
			return err
		}
		accts[addr] = a
		go a.Run(runCtx)
		go func(a *store.Account) {
			t := time.NewTicker(6 * time.Hour)
			defer t.Stop()
			for {
				select {
				case <-runCtx.Done():
					return
				case <-t.C:
					a.ForgetRaw()
				}
			}
		}(a)
	}
	b.mu.Lock()
	b.accounts, b.cancel, b.problem = accts, runCancel, ""
	b.mu.Unlock()
	return nil
}

func (b *Bridge) setProblem(p string) {
	b.mu.Lock()
	b.problem = p
	b.accounts = map[string]*store.Account{}
	b.mu.Unlock()
}

func safeName(s string) string {
	var out strings.Builder
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.', r == '-', r == '@', r == '_':
			out.WriteRune(r)
		default:
			out.WriteRune('_')
		}
	}
	return out.String()
}
