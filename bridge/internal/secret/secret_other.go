//go:build !windows

// Package secret keeps the API key and bridge password on disk. Outside Windows (used for testing) they're
// kept as they are, in a file only this user can read.
package secret

// Protect is a no-op outside Windows.
func Protect(plain string) (string, error) { return plain, nil }

// Reveal is a no-op outside Windows.
func Reveal(stored string) (string, error) { return stored, nil }
