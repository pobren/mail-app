//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

// Outside Windows the bridge runs without a tray icon (for testing on a Mac or Linux).

func setAutostart(bool) error { return nil }

func openBrowser(url string) { fmt.Println("Settings:", url) }

func fatal(msg string) {
	fmt.Fprintln(os.Stderr, msg)
	os.Exit(1)
}

func runTray(_ bool, _ string, stop func()) {
	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt, syscall.SIGTERM)
	<-c
	stop()
}
