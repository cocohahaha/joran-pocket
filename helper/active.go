package main

import (
	"os"
	"path/filepath"
	"time"
)

// On-demand activation — the helper boots in IDLE state (no signaling
// connection, no Cloudflare DO registered, no link valid). It transitions
// to ACTIVE only when this marker file exists, which `pocket attach`
// creates and `pocket sleep` removes. This narrows the window during
// which the pairing URL is reachable to "user explicitly opted in this
// session" instead of "helper is running."

func activeFilePath() string {
	return filepath.Join(pocketDir(), "active")
}

func isActive() bool {
	_, err := os.Stat(activeFilePath())
	return err == nil
}

func setActive() error {
	return os.WriteFile(activeFilePath(),
		[]byte(time.Now().Format(time.RFC3339)+"\n"), 0o644)
}

func clearActive() error {
	err := os.Remove(activeFilePath())
	if err != nil && os.IsNotExist(err) {
		return nil
	}
	return err
}
