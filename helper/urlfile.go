package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Small on-disk state shared between the long-running helper and the
// `pocket attach` / `pocket url` subcommands. Kept under ~/.pocket/.
//
// url.txt   — current pairing URL (https://…/p/ABCDEF). Read by
//             `pocket attach` to iMessage-push. Helper rewrites on
//             every successful register.
// code.txt  — raw pairing code (ABCDEF). Used on helper startup to
//             reuse the previous code across LaunchAgent restarts so
//             bookmarked URLs keep working.

func pocketDir() string {
	home, _ := os.UserHomeDir()
	d := filepath.Join(home, ".pocket")
	_ = os.MkdirAll(d, 0o755)
	return d
}

func urlFilePath() string  { return filepath.Join(pocketDir(), "url.txt") }
func codeFilePath() string { return filepath.Join(pocketDir(), "code.txt") }

func writeURLFile(pwaHost, code string) error {
	pwaHost = strings.TrimRight(pwaHost, "/")
	url := fmt.Sprintf("%s/p/%s\n", pwaHost, code)
	return os.WriteFile(urlFilePath(), []byte(url), 0o644)
}

func readURLFile() string {
	b, err := os.ReadFile(urlFilePath())
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func writePersistedCode(code string) error {
	return os.WriteFile(codeFilePath(), []byte(code+"\n"), 0o644)
}

func readPersistedCode() string {
	b, err := os.ReadFile(codeFilePath())
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}
