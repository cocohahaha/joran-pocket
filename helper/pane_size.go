package main

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// PaneSizeEvent tells the PWA what size the tmux pane is currently at so
// it can resize its xterm.js grid (cols × rows) to match. The phone then
// scrolls / pans to fit its viewport — content is byte-identical to what
// Mac sees.
type PaneSizeEvent struct {
	Type string `json:"type"` // always "pane_size"
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
	At   int64  `json:"at"`
}

// RunPaneSizeWatcher polls the tmux server every 200ms for the active
// pane's dimensions, keeps the helper's PTY in lock-step with them, and
// emits pane_size events to the phone whenever they change.
//
// 200ms (not 500) keeps the gap between "user runs `pocket attach` →
// pane suddenly grows" and "phone xterm resizes to match" subjectively
// instant. Combined with the explicit `tmux refresh-client` issued when
// we detect a size change, the phone gets a clean redraw at the new
// geometry within a couple of frames — no "swipe to fill" lag.
//
// Sizing policy (window-size=largest):
//   - External client (Mac Terminal) attached: pane = Mac's size,
//     helper grows to match so it reads the full pane content.
//   - Helper alone: helper shrinks to 42×20; pane becomes that.
func RunPaneSizeWatcher(ctx context.Context, session string, pty *tmuxPty, emit func(any)) {
	const (
		phoneDefaultCols uint16 = 42
		phoneDefaultRows uint16 = 20
	)
	tick := time.NewTicker(200 * time.Millisecond)
	defer tick.Stop()

	var lastEmitCols, lastEmitRows uint16
	var lastHelperCols, lastHelperRows uint16

	query := func() (paneCols, paneRows uint16, clients int, err error) {
		// Unit Separator — see listWindows for why we don't use \t.
		const sep = "\x1f"
		out, err := tmuxCmd("display-message", "-p", "-t", session,
			"#{pane_width}"+sep+"#{pane_height}"+sep+"#{session_attached}").Output()
		if err != nil {
			return 0, 0, 0, err
		}
		parts := strings.Split(strings.TrimSpace(string(out)), sep)
		if len(parts) != 3 {
			return 0, 0, 0, fmt.Errorf("tmux display-message: unexpected output %q", string(out))
		}
		w, e1 := strconv.Atoi(parts[0])
		h, e2 := strconv.Atoi(parts[1])
		c, e3 := strconv.Atoi(parts[2])
		if e1 != nil || e2 != nil || e3 != nil {
			return 0, 0, 0, fmt.Errorf("tmux display-message: parse error %q", string(out))
		}
		return uint16(w), uint16(h), c, nil
	}

	step := func() {
		paneCols, paneRows, clients, err := query()
		if err != nil {
			return
		}

		var targetCols, targetRows uint16
		if clients > 1 {
			targetCols, targetRows = paneCols, paneRows
		} else {
			targetCols, targetRows = phoneDefaultCols, phoneDefaultRows
		}

		if targetCols != lastHelperCols || targetRows != lastHelperRows {
			_ = pty.Resize(targetCols, targetRows)
			lastHelperCols, lastHelperRows = targetCols, targetRows
		}

		cols, rows := paneCols, paneRows
		if clients <= 1 {
			cols, rows = targetCols, targetRows
		}

		if cols != lastEmitCols || rows != lastEmitRows {
			emit(PaneSizeEvent{
				Type: "pane_size",
				Cols: cols,
				Rows: rows,
				At:   time.Now().UnixMilli(),
			})
			lastEmitCols, lastEmitRows = cols, rows

			// Force every attached client (helper's PTY, Mac Terminal,
			// any future viewer) to repaint at the new geometry. Without
			// this, tmux only re-emits content as new stdout fills the
			// pane — the phone keeps showing the pre-resize render
			// until the user types or scrolls. We iterate per-client
			// because `refresh-client` without -t targets only the
			// caller, and we're not a tmux client ourselves.
			out, err := tmuxCmd("list-clients", "-t", session, "-F", "#{client_tty}").Output()
			if err == nil {
				for _, tty := range strings.Split(strings.TrimSpace(string(out)), "\n") {
					if tty == "" {
						continue
					}
					_ = tmuxCmd("refresh-client", "-t", tty).Run()
				}
			}
		}
	}

	step() // emit current size immediately so phone resizes before pty bytes arrive
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			step()
		}
	}
}
