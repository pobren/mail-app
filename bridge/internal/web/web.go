// Package web is the bridge's settings page, at http://127.0.0.1:47825 on this computer only.
package web

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/pobren/mail-app/bridge/internal/bridge"
	"github.com/pobren/mail-app/bridge/internal/config"
)

//go:embed page.html
var page string

// Server is the settings page.
type Server struct {
	B *bridge.Bridge
	// SetAutostart turns starting with Windows on or off. Nil outside Windows.
	SetAutostart func(on bool) error
	token        string
	port         int
}

// New makes the settings page for a bridge.
func New(b *bridge.Bridge, port int) *Server {
	t := make([]byte, 16)
	_, _ = rand.Read(t)
	return &Server{B: b, token: hex.EncodeToString(t), port: port}
}

// URL is the settings page's address.
func (s *Server) URL() string { return fmt.Sprintf("http://127.0.0.1:%d/", s.port) }

// Listen starts the page. It fails when the port is taken, such as by a bridge that's already running.
func (s *Server) Listen() (net.Listener, error) {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", s.port))
	if err != nil {
		return nil, err
	}
	go http.Serve(ln, s)
	return ln, nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Only this page, as this computer reaches it: refuse other host names (DNS rebinding) and other
	// websites' pages (they don't have the token).
	host := r.Host
	if host != fmt.Sprintf("127.0.0.1:%d", s.port) && host != fmt.Sprintf("localhost:%d", s.port) {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'")
	if r.URL.Path == "/" && r.Method == http.MethodGet {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		html := strings.ReplaceAll(page, "{{TOKEN}}", s.token)
		html = strings.ReplaceAll(html, "{{VERSION}}", bridge.Version)
		_, _ = w.Write([]byte(html))
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/api/") {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	if r.Header.Get("X-Bridge-Token") != s.token {
		http.Error(w, "Not allowed", http.StatusForbidden)
		return
	}
	switch {
	case r.URL.Path == "/api/status" && r.Method == http.MethodGet:
		s.status(w)
	case r.URL.Path == "/api/connect" && r.Method == http.MethodPost:
		s.connect(w, r)
	case r.URL.Path == "/api/options" && r.Method == http.MethodPost:
		s.options(w, r)
	case r.URL.Path == "/api/password" && r.Method == http.MethodPost:
		_ = s.B.Settings.Update(func(c *config.Config) { c.Password = config.NewPassword() })
		s.status(w)
	default:
		http.Error(w, "Not found", http.StatusNotFound)
	}
}

type accountStatus struct {
	Address  string         `json:"address"`
	Ready    bool           `json:"ready"`
	LastSync string         `json:"lastSync"`
	Problem  string         `json:"problem"`
	Counts   map[string]int `json:"counts"`
}

func (s *Server) status(w http.ResponseWriter) {
	cfg := s.B.Settings.Get()
	var accts []accountStatus
	for _, a := range s.B.Accounts() {
		ready, last, problem, counts := a.Status()
		st := accountStatus{Address: a.Address, Ready: ready, Problem: problem, Counts: counts}
		if !last.IsZero() {
			st.LastSync = last.Format(time.RFC3339)
		}
		accts = append(accts, st)
	}
	writeJSON(w, map[string]any{
		"version": bridge.Version, "windows": runtime.GOOS == "windows",
		"server": cfg.Server, "keyHint": cfg.KeyHint, "password": cfg.Password,
		"problem": s.B.Problem(), "portProblems": s.B.PortProblems(),
		"imapPort": cfg.IMAPPort, "pop3Port": cfg.POP3Port, "smtpPort": cfg.SMTPPort,
		"keepMail": cfg.KeepMail, "markRead": cfg.MarkRead, "startWithWindows": cfg.StartWithWindows,
		"accounts": accts,
	})
}

func (s *Server) connect(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Server string `json:"server"`
		Key    string `json:"key"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&in); err != nil {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	in.Server, in.Key = strings.TrimSpace(in.Server), strings.TrimSpace(in.Key)
	err := s.B.Settings.Update(func(c *config.Config) {
		if in.Server != "" {
			c.Server = in.Server
		}
		if in.Key != "" {
			c.Key = in.Key
			if len(in.Key) > 16 {
				c.KeyHint = in.Key[:16] + "…"
			} else {
				c.KeyHint = in.Key
			}
		}
	})
	if err != nil {
		writeJSON(w, map[string]string{"error": err.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()
	_ = s.B.Connect(ctx)
	s.status(w)
}

func (s *Server) options(w http.ResponseWriter, r *http.Request) {
	var in struct {
		KeepMail         *bool `json:"keepMail"`
		MarkRead         *bool `json:"markRead"`
		StartWithWindows *bool `json:"startWithWindows"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in); err != nil {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	if in.StartWithWindows != nil && s.SetAutostart != nil {
		if err := s.SetAutostart(*in.StartWithWindows); err != nil {
			writeJSON(w, map[string]string{"error": "Couldn't change starting with Windows: " + err.Error()})
			return
		}
	}
	_ = s.B.Settings.Update(func(c *config.Config) {
		if in.KeepMail != nil {
			c.KeepMail = *in.KeepMail
		}
		if in.MarkRead != nil {
			c.MarkRead = *in.MarkRead
		}
		if in.StartWithWindows != nil {
			c.StartWithWindows = *in.StartWithWindows
		}
	})
	s.status(w)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
