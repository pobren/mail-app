// Package config is the bridge's settings, kept in the user's own settings folder.
package config

import (
	"crypto/rand"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/pobren/mail-app/bridge/internal/secret"
)

// AppName names the bridge's folders.
const AppName = "Mail App Bridge"

// Config is what's saved. The key and password are stored locked (see package secret).
type Config struct {
	Server   string `json:"server"`
	Key      string `json:"key"`
	Password string `json:"password"`
	KeyHint  string `json:"keyHint"`

	IMAPPort     int `json:"imapPort"`
	POP3Port     int `json:"pop3Port"`
	SMTPPort     int `json:"smtpPort"`
	SettingsPort int `json:"settingsPort"`

	// POP3: leave mail in Mail App when Outlook deletes it (on by default).
	KeepMail bool `json:"keepMail"`
	// POP3: mark mail as read in Mail App once Outlook downloads it (on by default).
	MarkRead bool `json:"markRead"`
	// Start the bridge when you sign in to Windows (on by default).
	StartWithWindows bool `json:"startWithWindows"`
}

// Defaults are the settings before anything is chosen.
func Defaults() Config {
	return Config{IMAPPort: 1143, POP3Port: 1110, SMTPPort: 1025, SettingsPort: 47825, KeepMail: true, MarkRead: true, StartWithWindows: true}
}

// Store loads and saves the settings.
type Store struct {
	mu   sync.Mutex
	path string
	cfg  Config
}

// Dir is where settings live (%APPDATA%\Mail App Bridge on Windows).
func Dir() string {
	base, err := os.UserConfigDir()
	if err != nil {
		base = "."
	}
	return filepath.Join(base, AppName)
}

// CacheDir is where each mailbox's state and email files are kept (%LOCALAPPDATA%\Mail App Bridge on Windows).
func CacheDir() string {
	base, err := os.UserCacheDir()
	if err != nil {
		base = "."
	}
	return filepath.Join(base, AppName)
}

// Open loads the settings from dir, making a bridge password the first time.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{path: filepath.Join(dir, "settings.json"), cfg: Defaults()}
	if b, err := os.ReadFile(s.path); err == nil {
		_ = json.Unmarshal(b, &s.cfg)
	}
	if s.cfg.Password == "" {
		p, err := secret.Protect(NewPassword())
		if err != nil {
			return nil, err
		}
		s.cfg.Password = p
		if err := s.saveLocked(); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// Get answers a copy of the settings, with the key and password unlocked.
func (s *Store) Get() Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.cfg
	c.Key, _ = secret.Reveal(c.Key)
	c.Password, _ = secret.Reveal(c.Password)
	return c
}

// Update changes the settings and saves them. Key and Password are given unlocked.
func (s *Store) Update(change func(c *Config)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.cfg
	c.Key, _ = secret.Reveal(c.Key)
	c.Password, _ = secret.Reveal(c.Password)
	change(&c)
	var err error
	if c.Key, err = secret.Protect(c.Key); err != nil {
		return err
	}
	if c.Password, err = secret.Protect(c.Password); err != nil {
		return err
	}
	s.cfg = c
	return s.saveLocked()
}

func (s *Store) saveLocked() error {
	b, err := json.MarshalIndent(s.cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// NewPassword makes a bridge password: easy to type, hard to guess.
func NewPassword() string {
	const letters = "abcdefghjkmnpqrstuvwxyz23456789"
	b := make([]byte, 20)
	_, _ = rand.Read(b)
	out := make([]byte, 0, 23)
	for i, x := range b {
		if i > 0 && i%5 == 0 {
			out = append(out, '-')
		}
		out = append(out, letters[int(x)%len(letters)])
	}
	return string(out)
}
