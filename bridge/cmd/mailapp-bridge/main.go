// Mail App Bridge: lets classic Outlook on Windows use a Mail App mailbox over IMAP, POP3 and SMTP. It runs
// in the system tray, listens on this computer only, and talks to Mail App over its API.
package main

import (
	"context"
	_ "embed"
	"flag"
	"io"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/pobren/mail-app/bridge/internal/bridge"
	"github.com/pobren/mail-app/bridge/internal/config"
	"github.com/pobren/mail-app/bridge/internal/web"
)

//go:embed assets/icon.ico
var iconICO []byte

func main() {
	background := flag.Bool("background", false, "start quietly, without opening the settings page")
	headless := flag.Bool("headless", false, "no tray icon (for testing)")
	settingsDir := flag.String("settings", config.Dir(), "settings folder")
	cacheDir := flag.String("cache", config.CacheDir(), "folder for each mailbox's state and email files")
	flag.Parse()

	if err := os.MkdirAll(*cacheDir, 0o700); err == nil {
		if f, err := openLog(filepath.Join(*cacheDir, "bridge.log")); err == nil {
			log.SetOutput(io.MultiWriter(os.Stderr, f))
		}
	}
	settings, err := config.Open(*settingsDir)
	if err != nil {
		fatal("Couldn't open the bridge's settings: " + err.Error())
	}
	cfg := settings.Get()
	b := bridge.New(settings, *cacheDir)
	page := web.New(b, cfg.SettingsPort)

	// Already running? Then just show its settings page.
	if _, err := page.Listen(); err != nil {
		if !*background {
			openBrowser(page.URL())
		}
		return
	}

	page.SetAutostart = setAutostart
	if cfg.StartWithWindows {
		_ = setAutostart(true)
	}
	b.Listen()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
		defer cancel()
		_ = b.Connect(ctx)
	}()
	log.Printf("Mail App Bridge %s running. Settings: %s", bridge.Version, page.URL())
	if !*background && !*headless {
		go func() {
			time.Sleep(500 * time.Millisecond)
			openBrowser(page.URL())
		}()
	}
	runTray(*headless, page.URL(), func() { b.Close() })
}

// openLog keeps the log to a few megabytes by starting it again when it gets big.
func openLog(path string) (*os.File, error) {
	if st, err := os.Stat(path); err == nil && st.Size() > 5<<20 {
		_ = os.Rename(path, path+".old")
	}
	return os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
}
