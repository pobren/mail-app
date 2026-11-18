//go:build windows

package main

import (
	"os"
	"os/exec"

	"fyne.io/systray"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const runKey = `Software\Microsoft\Windows\CurrentVersion\Run`
const runName = "Mail App Bridge"

func setAutostart(on bool) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	if !on {
		if err := k.DeleteValue(runName); err != nil && err != registry.ErrNotExist {
			return err
		}
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return k.SetStringValue(runName, `"`+exe+`" --background`)
}

func openBrowser(url string) {
	_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}

func fatal(msg string) {
	t, _ := windows.UTF16PtrFromString("Mail App Bridge")
	m, _ := windows.UTF16PtrFromString(msg)
	windows.MessageBox(0, m, t, windows.MB_OK|windows.MB_ICONERROR)
	os.Exit(1)
}

func runTray(headless bool, url string, stop func()) {
	if headless {
		select {}
	}
	systray.Run(func() {
		systray.SetIcon(iconICO)
		systray.SetTooltip("Mail App Bridge")
		open := systray.AddMenuItem("Open settings", "Settings and Outlook details")
		systray.AddSeparator()
		quit := systray.AddMenuItem("Quit", "Outlook can't get mail while the bridge is closed")
		systray.SetOnTapped(func() { openBrowser(url) })
		go func() {
			for {
				select {
				case <-open.ClickedCh:
					openBrowser(url)
				case <-quit.ClickedCh:
					systray.Quit()
					return
				}
			}
		}()
	}, stop)
}
