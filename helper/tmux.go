package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"

	"github.com/creack/pty"
)

// pocketSocket is the dedicated tmux socket name for the pocket session.
// Using a separate socket (tmux -L pocket) isolates us from any other
// tmux server the user may have running. The same name is used in the
// zshrc auto-attach snippet and the `pocket attach` subcommand.
const pocketSocket = "pocket"

// tmuxEnv guarantees tmux sees a UTF-8 locale. When helper runs under
// LaunchAgent, the inherited environment has no LANG / LC_* and tmux
// silently replaces every non-ASCII-printable byte it emits — including
// our format-string separators — with underscores. That broke
// list-windows parsing (every line came back as "1_zsh_0_1" with parts=1)
// and turned every tmux emission into garbage. Export a UTF-8 locale
// on every tmux invocation so the bytes survive.
func tmuxEnv() []string {
	env := os.Environ()
	// Preserve existing if user already exported something.
	hasLang := false
	hasLC := false
	for _, e := range env {
		if len(e) >= 5 && e[:5] == "LANG=" {
			hasLang = true
		}
		if len(e) >= 7 && e[:7] == "LC_ALL=" {
			hasLC = true
		}
	}
	if !hasLang {
		env = append(env, "LANG=en_US.UTF-8")
	}
	if !hasLC {
		env = append(env, "LC_ALL=en_US.UTF-8")
	}
	return env
}

// tmuxCmd returns an exec.Cmd for `tmux -L pocket <args...>`. On server-
// spawning subcommands (new-session), we additionally supply the config
// file via -f so options apply from the very first byte the server serves.
func tmuxCmd(args ...string) *exec.Cmd {
	all := []string{"-L", pocketSocket}
	all = append(all, args...)
	c := exec.Command("tmux", all...)
	c.Env = tmuxEnv()
	return c
}

func tmuxCmdWithConf(args ...string) *exec.Cmd {
	all := []string{"-L", pocketSocket, "-f", tmuxConfPath()}
	all = append(all, args...)
	c := exec.Command("tmux", all...)
	c.Env = tmuxEnv()
	return c
}

// tmuxPty wraps a tmux client process attached to a given session, exposing
// the PTY's master FD for read/write. Closing it gracefully detaches.
type tmuxPty struct {
	cmd  *exec.Cmd
	fd   *os.File
	mu   sync.Mutex
	done bool
}

// openTmuxPty ensures the named tmux session exists (creating it detached if
// not), then spawns `tmux attach-session -t <name>` under a pseudo-terminal
// and returns its master FD.
func openTmuxPty(ctx context.Context, session string) (*tmuxPty, error) {
	if err := ensureSession(session); err != nil {
		return nil, err
	}

	cmd := tmuxCmd("-u", "attach-session", "-t", session)
	cmd.Env = append(tmuxEnv(), "TERM=xterm-256color")
	// Start SMALL (phone default) so helper's client doesn't inflate
	// the pane when alone. With window-size=largest, pane follows the
	// LARGEST attached client — so when Mac's Terminal attaches, pane
	// grows to Mac's full size and Claude renders natively. When only
	// helper is attached, pane is 42×20 → phone sees a compact view.
	// RunPaneSizeWatcher adjusts helper's size in lock-step with the
	// pane so we always read the exact bytes the pane renders.
	fd, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 20, Cols: 42})
	if err != nil {
		return nil, fmt.Errorf("start pty for tmux attach: %w", err)
	}
	return &tmuxPty{cmd: cmd, fd: fd}, nil
}

func ensureSession(session string) error {
	// Make sure our config file is on disk before tmux might need it.
	_ = WriteTmuxConf()

	has := tmuxCmd("has-session", "-t", session)
	if err := has.Run(); err != nil {
		// No server / no session — start one with our config file baked
		// in via -f so options apply from server birth.
		create := tmuxCmdWithConf("new-session", "-d", "-s", session)
		create.Env = append(tmuxEnv(), "TERM=xterm-256color")
		out, err := create.CombinedOutput()
		if err != nil {
			return fmt.Errorf("tmux new-session: %w: %s", err, string(out))
		}
	}
	// Apply helper-owned tmux options. Kept minimal and opinionated:
	//
	// - mouse off: touch on phone scrolls xterm.js local buffer; mouse on
	//   would route touches into tmux and break scroll.
	// - status off: hide tmux's status line (the PWA has its own tab bar
	//   and compose UI; Mac Terminal users see a clean shell).
	// - history-limit 20000: tmux-side scrollback for capture-pane + session
	//   persistence.
	// - window-size largest: pane follows the LARGEST attached client.
	//   When Mac's Terminal.app attaches, pane grows to Mac's native size
	//   so Claude Code renders correctly. The helper's PTY tracks pane
	//   size via RunPaneSizeWatcher so we always read exactly what the
	//   pane renders — phone CSS-scales the full-size grid to fit.
	for _, args := range [][]string{
		{"set-option", "-g", "mouse", "off"},
		{"set-option", "-g", "status", "off"},
		{"set-option", "-g", "history-limit", "20000"},
		{"set-option", "-g", "status-interval", "5"},
		{"set-option", "-g", "window-size", "largest"},
		// Keep tmux on Mac Terminal's main screen so trackpad scroll
		// reveals history naturally. See tmux_conf.go for why.
		{"set-option", "-g", "terminal-overrides", "xterm*:smcup@:rmcup@"},
	} {
		_ = tmuxCmd(args...).Run()
	}
	return nil
}

// Read implements io.Reader — PTY output (terminal rendered bytes).
func (t *tmuxPty) Read(p []byte) (int, error) {
	t.mu.Lock()
	fd := t.fd
	done := t.done
	t.mu.Unlock()
	if done || fd == nil {
		return 0, io.EOF
	}
	return fd.Read(p)
}

// Write sends bytes to the PTY (user keystrokes).
func (t *tmuxPty) Write(p []byte) (int, error) {
	t.mu.Lock()
	fd := t.fd
	done := t.done
	t.mu.Unlock()
	if done || fd == nil {
		return 0, io.ErrClosedPipe
	}
	return fd.Write(p)
}

// Resize sends a window resize to the PTY. Call when phone reports new size.
func (t *tmuxPty) Resize(cols, rows uint16) error {
	t.mu.Lock()
	fd := t.fd
	t.mu.Unlock()
	if fd == nil {
		return io.ErrClosedPipe
	}
	return pty.Setsize(fd, &pty.Winsize{Rows: rows, Cols: cols})
}

// Close detaches our tmux client (does NOT kill the session; other attachers
// continue to see it, and the session persists).
func (t *tmuxPty) Close() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.done {
		return nil
	}
	t.done = true
	if t.fd != nil {
		_ = t.fd.Close()
	}
	if t.cmd != nil && t.cmd.Process != nil {
		_ = t.cmd.Process.Signal(syscall.SIGHUP)
		// Don't wait — let it reap in the background.
		go t.cmd.Wait()
	}
	return nil
}

// CapturePane returns the last N lines of the session's current pane content.
// Used by the Claude-state watcher.
func CapturePane(session string, lines int) (string, error) {
	cmd := tmuxCmd("capture-pane", "-p", "-t", session, "-S", fmt.Sprintf("-%d", lines))
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}
