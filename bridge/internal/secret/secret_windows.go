//go:build windows

// Package secret keeps the API key and bridge password safe on disk. On Windows they're locked to the
// signed-in Windows user with DPAPI, so another user of the computer (or a copied file) can't read them.
package secret

import (
	"encoding/base64"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Protect locks text to this Windows user.
func Protect(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	in := []byte(plain)
	var out windows.DataBlob
	err := windows.CryptProtectData(&windows.DataBlob{Size: uint32(len(in)), Data: &in[0]}, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out)
	if err != nil {
		return "", err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return "dpapi:" + base64.StdEncoding.EncodeToString(unsafe.Slice(out.Data, out.Size)), nil
}

// Reveal unlocks text Protect locked.
func Reveal(stored string) (string, error) {
	if len(stored) < 6 || stored[:6] != "dpapi:" {
		return stored, nil
	}
	in, err := base64.StdEncoding.DecodeString(stored[6:])
	if err != nil || len(in) == 0 {
		return "", err
	}
	var out windows.DataBlob
	err = windows.CryptUnprotectData(&windows.DataBlob{Size: uint32(len(in)), Data: &in[0]}, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out)
	if err != nil {
		return "", err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return string(unsafe.Slice(out.Data, out.Size)), nil
}
