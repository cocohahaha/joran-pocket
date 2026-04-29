package main

import (
	"os"
	"path/filepath"
	"strings"
)

// Password gate: even though the pairing URL is stable, we want a second
// factor so a leaked link alone can't control the Mac. The password lives
// in ~/.pocket/password.txt (user-owned, mode 0600) and is verified over
// the WebRTC sidechannel (never touches the signaling Worker). Default
// "0523" is created on first run; user can edit the file to change it.

func passwordFile() string { return filepath.Join(pocketDir(), "password.txt") }

// loadPassword returns the current password, creating the file with a
// default if it doesn't exist. Trims trailing whitespace/newlines. Returns
// "" only if the file is unreadable (rare — caller should treat "" as
// "any password accepted" deliberately since you can't lock yourself out
// just by deleting the file).
func loadPassword() string {
	b, err := os.ReadFile(passwordFile())
	if err != nil {
		// First-time: write the default so user can edit it later.
		_ = os.MkdirAll(pocketDir(), 0o755)
		_ = os.WriteFile(passwordFile(), []byte("0523\n"), 0o600)
		return "0523"
	}
	return strings.TrimRight(strings.TrimSpace(string(b)), "\r\n")
}

// verifyPassword returns true if p matches the stored password. A blank
// stored password disables the gate (matches any input including empty).
func verifyPassword(p string) bool {
	expected := loadPassword()
	if expected == "" {
		return true
	}
	return p == expected
}
