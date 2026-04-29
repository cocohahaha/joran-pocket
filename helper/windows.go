package main

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"
)

// Window is one tmux window in the shared session.
type Window struct {
	Index  int    `json:"index"`
	Name   string `json:"name"`
	Active bool   `json:"active"`
	Panes  int    `json:"panes"`
}

// WindowsEvent is pushed on the sidechannel whenever the window list (or
// active-window) changes. PWA renders these as horizontal tabs.
type WindowsEvent struct {
	Type        string   `json:"type"` // always "windows"
	Windows     []Window `json:"windows"`
	ActiveIndex int      `json:"active_index"`
	At          int64    `json:"at"`
}

// RunWindowsWatcher polls `tmux list-windows` every 1s. Emits a snapshot
// immediately on startup, then only when it differs from the previous one.
// The immediate-emit avoids the phone seeing "waiting for window list…" for
// a full second after connecting.
func RunWindowsWatcher(ctx context.Context, session string, emit func(any)) {
	tick := time.NewTicker(1 * time.Second)
	defer tick.Stop()

	var last string
	emitOnce := func() {
		wins, activeIdx, raw, err := listWindows(session)
		if err != nil {
			return
		}
		// Don't emit an empty list — tmux always has ≥1 window per
		// session, so 0 means we queried too early (session creating)
		// or parsing hit an edge case. The phone would render that as
		// "等待 tmux 窗口列表…" forever if we didn't wait.
		if len(wins) == 0 {
			return
		}
		if raw == last {
			return
		}
		last = raw
		log.Printf("windows watcher: emit %d window(s) active=%d",
			len(wins), activeIdx)
		emit(WindowsEvent{
			Type:        "windows",
			Windows:     wins,
			ActiveIndex: activeIdx,
			At:          time.Now().UnixMilli(),
		})
	}

	emitOnce() // immediate
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			emitOnce()
		}
	}
}

// listWindows queries tmux for windows in the session. Returns the parsed
// list, the index of the active window, and the raw stdout (used for
// cheap change-detection).
//
// Separator is the ASCII Unit Separator (\x1f) — a byte that will
// never appear in a tmux window name. Tab (\t) was unreliable in
// practice: in one observed setup tmux delivered the bytes back as
// literal underscores to this process, breaking the SplitN parse.
func listWindows(session string) ([]Window, int, string, error) {
	const sep = "\x1f"
	format := "#{window_index}" + sep + "#{window_name}" + sep +
		"#{?window_active,1,0}" + sep + "#{window_panes}"
	cmd := tmuxCmd("list-windows", "-t", session, "-F", format)
	out, err := cmd.CombinedOutput()
	raw := string(out)
	if err != nil {
		log.Printf("listWindows(%q) failed: %v; raw=%q", session, err, raw)
		return nil, 0, raw, err
	}

	wins := make([]Window, 0, 8)
	activeIdx := 0
	for _, line := range strings.Split(strings.TrimRight(raw, "\n"), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, sep, 4)
		if len(parts) != 4 {
			log.Printf("listWindows: odd line (parts=%d): %q", len(parts), line)
			continue
		}
		idx, err := strconv.Atoi(parts[0])
		if err != nil {
			log.Printf("listWindows: bad index %q: %v", parts[0], err)
			continue
		}
		active := parts[2] == "1"
		panes, _ := strconv.Atoi(parts[3])
		w := Window{Index: idx, Name: parts[1], Active: active, Panes: panes}
		wins = append(wins, w)
		if active {
			activeIdx = idx
		}
	}
	return wins, activeIdx, raw, nil
}

// Control commands issued by the phone via sidechannel.

func SelectWindow(session string, index int) error {
	return tmuxCmd("select-window", "-t", fmt.Sprintf("%s:%d", session, index)).Run()
}

func NewWindow(session string) error {
	return tmuxCmd("new-window", "-t", session).Run()
}

func KillWindow(session string, index int) error {
	return tmuxCmd("kill-window", "-t", fmt.Sprintf("%s:%d", session, index)).Run()
}

func RenameWindow(session string, index int, name string) error {
	// Strip any shell-unfriendly characters conservatively.
	name = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return -1
		}
		return r
	}, name)
	if name == "" {
		return fmt.Errorf("empty name")
	}
	return tmuxCmd("rename-window", "-t", fmt.Sprintf("%s:%d", session, index), name).Run()
}
