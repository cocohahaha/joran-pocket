package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// iMessageRecipient reads the recipient from (in priority order):
//  1. POCKET_IMESSAGE_TO environment variable
//  2. ~/.pocket/imessage-to.txt
//  3. ~/Pocket/imessage-to.txt (legacy path from the ttyd-era)
// Returns empty string if none found.
func iMessageRecipient() string {
	if s := strings.TrimSpace(os.Getenv("POCKET_IMESSAGE_TO")); s != "" {
		return s
	}
	home, _ := os.UserHomeDir()
	for _, p := range []string{
		filepath.Join(home, ".pocket", "imessage-to.txt"),
		filepath.Join(home, "Pocket", "imessage-to.txt"),
	} {
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		r := strings.TrimSpace(string(b))
		if r != "" {
			return r
		}
	}
	return ""
}

// SendIMessage fires off an AppleScript call to Messages.app to send
// `msg` to `to`. Non-blocking (best-effort) and never returns an error —
// iMessage availability depends on macOS user login state.
func SendIMessage(to, msg string) {
	if to == "" || msg == "" {
		return
	}
	escaped := strings.ReplaceAll(msg, `"`, `\"`)
	script := fmt.Sprintf(`tell application "Messages"
  try
    set theService to 1st service whose service type = iMessage
    set theBuddy to buddy "%s" of theService
    send "%s" to theBuddy
  end try
end tell`, to, escaped)
	cmd := exec.Command("osascript", "-e", script)
	// Fire-and-forget: don't wait, don't care about errors (Messages may
	// not be signed in; that's the user's problem to fix).
	_ = cmd.Start()
	go func() { _ = cmd.Wait() }()
}
