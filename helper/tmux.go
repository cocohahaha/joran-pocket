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

	cmd := exec.Command("tmux", "-u", "attach-session", "-t", session)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	fd, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 40, Cols: 120})
	if err != nil {
		return nil, fmt.Errorf("start pty for tmux attach: %w", err)
	}
	return &tmuxPty{cmd: cmd, fd: fd}, nil
}

func ensureSession(session string) error {
	has := exec.Command("tmux", "has-session", "-t", session)
	if err := has.Run(); err != nil {
		// Not found — create detached.
		create := exec.Command("tmux", "new-session", "-d", "-s", session)
		create.Env = append(os.Environ(), "TERM=xterm-256color")
		out, err := create.CombinedOutput()
		if err != nil {
			return fmt.Errorf("tmux new-session: %w: %s", err, string(out))
		}
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
	cmd := exec.Command("tmux", "capture-pane", "-p", "-t", session, "-S", fmt.Sprintf("-%d", lines))
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}
