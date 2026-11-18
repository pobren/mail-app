package store

import (
	"bufio"
	"bytes"
	"context"
	"net/textproto"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

var safeID = regexp.MustCompile(`^[A-Za-z0-9._-]{1,200}$`)

func (a *Account) rawPath(id string) string {
	return filepath.Join(a.dir, "raw", id+".eml")
}

func (a *Account) writeRaw(id string, raw []byte) error {
	if !safeID.MatchString(id) {
		return nil
	}
	tmp := a.rawPath(id) + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, a.rawPath(id))
}

// Raw is an email's file, from the bridge's cache or else from Mail App. Emails don't change once they're
// in Mail App, so a cached copy stays good.
func (a *Account) Raw(ctx context.Context, id string) ([]byte, error) {
	if safeID.MatchString(id) {
		if b, err := os.ReadFile(a.rawPath(id)); err == nil {
			return b, nil
		}
	}
	a.rawMu.Lock()
	l, ok := a.rawLocks[id]
	if !ok {
		l = &sync.Mutex{}
		a.rawLocks[id] = l
	}
	a.rawMu.Unlock()
	l.Lock()
	defer func() {
		l.Unlock()
		a.rawMu.Lock()
		delete(a.rawLocks, id)
		a.rawMu.Unlock()
	}()
	if safeID.MatchString(id) {
		if b, err := os.ReadFile(a.rawPath(id)); err == nil {
			return b, nil
		}
	}
	b, err := a.client.Raw(ctx, a.Address, id)
	if err != nil {
		return nil, err
	}
	b = crlf(b)
	_ = a.writeRaw(id, b)
	return b, nil
}

// CachedSize is the size of an email's file if it's already in the cache, or -1.
func (a *Account) CachedSize(id string) int64 {
	if !safeID.MatchString(id) {
		return -1
	}
	st, err := os.Stat(a.rawPath(id))
	if err != nil {
		return -1
	}
	return st.Size()
}

// ForgetRaw removes cached files for emails the bridge no longer shows anywhere.
func (a *Account) ForgetRaw() {
	a.Mu.Lock()
	keep := map[string]bool{}
	for _, f := range a.Folders {
		for _, m := range f.Msgs {
			keep[m.ID] = true
		}
	}
	a.Mu.Unlock()
	entries, _ := os.ReadDir(filepath.Join(a.dir, "raw"))
	for _, e := range entries {
		id := strings.TrimSuffix(e.Name(), ".eml")
		if !keep[id] {
			_ = os.Remove(filepath.Join(a.dir, "raw", e.Name()))
		}
	}
}

// crlf makes every line end CRLF, as IMAP and POP3 need.
func crlf(b []byte) []byte {
	if !bytes.Contains(b, []byte("\n")) {
		return b
	}
	var out bytes.Buffer
	out.Grow(len(b) + len(b)/40)
	for i := 0; i < len(b); i++ {
		c := b[i]
		if c == '\n' && (i == 0 || b[i-1] != '\r') {
			out.WriteByte('\r')
		}
		out.WriteByte(c)
	}
	return out.Bytes()
}

// messageID reads the Message-ID header of an email file.
func messageID(raw []byte) string {
	r := textproto.NewReader(bufio.NewReader(bytes.NewReader(raw)))
	h, err := r.ReadMIMEHeader()
	if err != nil && len(h) == 0 {
		return ""
	}
	return strings.Trim(h.Get("Message-Id"), "<> \t")
}
