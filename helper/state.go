package main

import (
	"context"
	"regexp"
	"strings"
	"time"
)

// ClaudeEvent is what the helper pushes on the sidechannel DataChannel.
// The PWA listens for these to render approval sheets, tool-call cards, etc.
type ClaudeEvent struct {
	Type    string            `json:"type"`              // awaiting_approval | executing_bash | diff_ready | idle
	Text    string            `json:"text,omitempty"`    // prompt / command / diff summary
	Details map[string]string `json:"details,omitempty"` // free-form extras
	At      int64             `json:"at"`                // unix ms
}

// RunStateWatcher polls tmux pane content every 500ms, diffs against last
// observation, and fires ClaudeEvents through `emit` when it detects a
// recognizable Claude Code state transition.
//
// Regexes here are conservative — better to miss an event than misfire one
// (misfires surprise the user with phantom approval prompts).
//
// `emit` accepts any JSON-serializable struct; callers marshal + ship.
func RunStateWatcher(ctx context.Context, session string, emit func(any)) {
	var lastType string
	var lastSeen string

	approvalRe := regexp.MustCompile(`(?mi)(do you want to proceed\?|continue\?|\(y/n\)|\[y/n\])`)
	bashStartRe := regexp.MustCompile(`(?m)^(?:│\s*)?Bash\((.+)\)\s*$`)
	diffRe := regexp.MustCompile(`(?m)^[+-]{3}\s|^@@ `)

	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}

		pane, err := CapturePane(session, 80)
		if err != nil {
			continue
		}
		if pane == lastSeen {
			continue
		}
		lastSeen = pane

		now := time.Now().UnixMilli()
		trimmed := strings.TrimSpace(pane)

		switch {
		case approvalRe.MatchString(trimmed[maxStart(trimmed, 400):]):
			if lastType != "awaiting_approval" {
				lastType = "awaiting_approval"
				emit(ClaudeEvent{
					Type: "awaiting_approval",
					Text: lastNonEmptyLine(trimmed),
					At:   now,
				})
			}
		case bashStartRe.MatchString(trimmed[maxStart(trimmed, 400):]):
			m := bashStartRe.FindStringSubmatch(trimmed[maxStart(trimmed, 400):])
			cmd := ""
			if len(m) > 1 {
				cmd = m[1]
			}
			if lastType != "executing_bash" {
				lastType = "executing_bash"
				emit(ClaudeEvent{Type: "executing_bash", Text: cmd, At: now})
			}
		case diffRe.MatchString(trimmed):
			if lastType != "diff_ready" {
				lastType = "diff_ready"
				emit(ClaudeEvent{Type: "diff_ready", At: now})
			}
		default:
			if lastType != "idle" {
				lastType = "idle"
				emit(ClaudeEvent{Type: "idle", At: now})
			}
		}
	}
}

func maxStart(s string, tail int) int {
	if len(s) <= tail {
		return 0
	}
	return len(s) - tail
}

func lastNonEmptyLine(s string) string {
	lines := strings.Split(s, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		l := strings.TrimSpace(lines[i])
		if l != "" {
			return l
		}
	}
	return ""
}
