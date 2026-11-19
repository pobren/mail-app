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
	stops    map[string]context.CancelFunc // per mailbox
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
	b.mu.Lock()
	b.accounts, b.cancel, b.problem = map[string]*store.Account{}, runCancel, ""
	b.stops = map[string]context.CancelFunc{}
	b.mu.Unlock()
	if err := b.useMailboxes(runCtx, client, boxes); err != nil {
		runCancel()
		b.setProblem(err.Error())
		return err
	}
	// Mailboxes added to (or taken off) the key later show up without pressing Save and connect again.
	go func() {
		t := time.NewTicker(MailboxCheck)
		defer t.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-t.C:
				c, cancel := context.WithTimeout(runCtx, 30*time.Second)
				boxes, err := client.Mailboxes(c)
				cancel()
				if err != nil {
					log.Printf("checking for new mailboxes: %v", err)
					continue
				}
				if err := b.useMailboxes(runCtx, client, boxes); err != nil {
					log.Printf("adding a mailbox: %v", err)
				}
			}
		}
	}()
	return nil
}

// MailboxCheck is how often the bridge asks Mail App which mailboxes the key can use.
var MailboxCheck = 5 * time.Minute

// useMailboxes starts keeping each new mailbox in step, and stops any the key can no longer use.
func (b *Bridge) useMailboxes(runCtx context.Context, client *api.Client, boxes []api.Mailbox) error {
	want := map[string]bool{}
	for _, m := range boxes {
		addr := strings.ToLower(m.Email)
		if addr == "" {
			addr = strings.ToLower(m.ID)
		}
		want[addr] = true
		b.mu.Lock()
		_, have := b.accounts[addr]
		b.mu.Unlock()
		if have {
			continue
		}
		dir := filepath.Join(b.cacheDir, "mailboxes", safeName(client.Base+"_"+addr))
		a, err := store.New(addr, client, dir)
		if err != nil {
			return err
		}
		ctx, stop := context.WithCancel(runCtx)
		b.mu.Lock()
		if runCtx.Err() != nil { // a newer Connect took over
			b.mu.Unlock()
			stop()
			return nil
		}
		b.accounts[addr], b.stops[addr] = a, stop
		b.mu.Unlock()
		log.Printf("%s: keeping in step", addr)
		go a.Run(ctx)
		go func(a *store.Account) {
			t := time.NewTicker(6 * time.Hour)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
					a.ForgetRaw()
				}
			}
		}(a)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if runCtx.Err() != nil {
		return nil
	}
	for addr := range b.accounts {
		if !want[addr] {
			log.Printf("%s: the key can no longer use this mailbox", addr)
			if stop := b.stops[addr]; stop != nil {
				stop()
			}
			delete(b.accounts, addr)
			delete(b.stops, addr)
		}
	}
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
