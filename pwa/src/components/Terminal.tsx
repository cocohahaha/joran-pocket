import { useEffect, useRef } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";

interface Props {
  onData: (s: string) => void;
  registerWriter: (writeBytes: (b: ArrayBuffer | string) => void) => void;
  cols: number;
  rows: number;
}

const FONT_SIZE = 15;
const LINE_HEIGHT = 1.2;
// JetBrains Mono / SF Mono: glyph width ≈ 0.6 × fontSize for ASCII, 1.2
// for CJK. We compute explicit dimensions based on the Mac pane so the
// outer wrapper knows exactly how wide/tall the terminal is and can
// scroll in both axes.
const CHAR_W = FONT_SIZE * 0.6;  // ≈ 9
const ROW_H  = FONT_SIZE * LINE_HEIGHT; // 18
const BUFFER_CAP_BYTES = 2_000_000;

// Inject CSS once. Overrides the parts of xterm's default stylesheet
// that interfere with a simple scroll-the-whole-terminal layout:
//
// .xterm-viewport — defaults to overflow-y:scroll, which on iOS Safari
//   captures all vertical touches even when there's nothing to scroll,
//   blocking the outer container's native scroll.
// .xterm itself — occasionally picks up a 0 padding or unexpected
//   background; we neutralise both so our wrapper paints edges cleanly.
function injectXtermOverrides() {
  const id = "pocket-xterm-overrides";
  if (typeof document === "undefined" || document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  // Two critical rules:
  //
  // 1. `.xterm-viewport { overflow: visible }` — xterm's default
  //    overflow-y:scroll on the viewport eats iOS touch events so the
  //    outer scroll container never sees them.
  //
  // 2. `.xterm-rows > div { white-space: nowrap; overflow: visible }` —
  //    xterm gives each row an explicit pixel width of `cols × charW`,
  //    computed from the ASCII glyph advance. On iOS Safari the CJK
  //    fallback font renders 2-cell glyphs a subpixel or two wider than
  //    `2 × charW`. Over a 40-CJK-char line the drift overflows the
  //    row's box and the browser visually wraps the last few glyphs to
  //    the next line — exactly the "right-edge clip + premature wrap"
  //    users see. Forcing nowrap + visible overflow lets the glyphs
  //    paint past the nominal row width; the outer wrapper (via our
  //    `syncMountToXterm` measurement) then captures that true width
  //    and scrolls to reveal them.
  style.textContent = `
    .pocket-mount .xterm {
      padding: 0 !important;
      background: transparent !important;
    }
    .pocket-mount .xterm .xterm-viewport {
      overflow: visible !important;
    }
    .pocket-mount .xterm .xterm-screen {
      position: relative !important;
      overflow: visible !important;
    }
    .pocket-mount .xterm .xterm-rows {
      overflow: visible !important;
    }
    .pocket-mount .xterm .xterm-rows > div {
      /* white-space: pre preserves runs of spaces (critical for
         terminal indentation) and disables wrapping. The simpler
         nowrap value collapses consecutive spaces, erasing ASCII
         padding that tmux / Claude emit. */
      white-space: pre !important;
      overflow: visible !important;
    }
  `;
  document.head.appendChild(style);
}

export function TerminalView({ onData, registerWriter, cols, rows }: Props) {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerminal | null>(null);

  const readyRef = useRef<boolean>(false);
  const bufferRef = useRef<Array<string | ArrayBuffer>>([]);
  const bufferSizeRef = useRef<number>(0);

  useEffect(() => {
    injectXtermOverrides();
    const el = mountRef.current!;
    const term = new XTerminal({
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
      fontSize: FONT_SIZE,
      lineHeight: LINE_HEIGHT,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: "bar",
      // Non-zero so the pull-down-at-top gesture has history to reveal.
      // Each incoming row from Mac that scrolls off the top of the current
      // pane gets kept here for the user to pull into view.
      scrollback: 5000,
      macOptionIsMeta: true,
      allowTransparency: false,
      convertEol: false,
      disableStdin: false,
      screenReaderMode: false,
      cols: 42,
      rows: 20,
      theme: {
        background: "#0b0d12",
        foreground: "#e6e6e6",
        cursor: "#f97316",
        cursorAccent: "#0b0d12",
        selectionBackground: "#2a3344",
        black: "#1e1e1e",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#3b82f6",
        magenta: "#a855f7",
        cyan: "#06b6d4",
        white: "#e6e6e6",
        brightBlack: "#525252",
        brightRed: "#f87171",
        brightGreen: "#4ade80",
        brightYellow: "#fbbf24",
        brightBlue: "#60a5fa",
        brightMagenta: "#c084fc",
        brightCyan: "#22d3ee",
        brightWhite: "#fafafa",
      },
    });

    term.open(el);
    // Unicode v11 char-width rules — without this, xterm treats CJK
    // characters as 1 column wide, while tmux (which matches the pane
    // to the Mac Terminal's terminfo) treats them as 2. Every CJK char
    // then misaligns cursor positions and clips the trailing columns
    // of each line. Activating the addon restores byte-perfect parity.
    try {
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = "11";
    } catch (e) {
      console.warn("unicode11 addon failed:", e);
    }
    termRef.current = term;
    term.onData(onData);

    // Auto-follow the tail: on new output, scroll outer to the bottom so
    // the cursor/prompt stays visible. Skip if the user manually scrolled
    // up to read something — don't fight them.
    // Also re-sync mount dimensions in case incoming CJK or wide chars
    // pushed the terminal's actual rendered width beyond our last measure.
    const onRender = () => {
      syncMountToXterm();
      const outer = outerRef.current;
      if (!outer) return;
      const gap = outer.scrollHeight - outer.scrollTop - outer.clientHeight;
      if (gap < 40) {
        requestAnimationFrame(() => {
          if (outerRef.current) outerRef.current.scrollTop = outerRef.current.scrollHeight;
        });
      }
    };
    const renderDisposable = term.onRender(onRender);

    const writer = (b: ArrayBuffer | string) => {
      if (!readyRef.current) {
        const size = typeof b === "string" ? b.length : b.byteLength;
        if (bufferSizeRef.current + size > BUFFER_CAP_BYTES) {
          while (bufferSizeRef.current + size > BUFFER_CAP_BYTES && bufferRef.current.length > 0) {
            const old = bufferRef.current.shift()!;
            bufferSizeRef.current -= typeof old === "string" ? old.length : old.byteLength;
          }
        }
        bufferRef.current.push(b);
        bufferSizeRef.current += size;
        return;
      }
      if (typeof b === "string") term.write(b);
      else term.write(new Uint8Array(b));
    };
    registerWriter(writer);

    return () => {
      renderDisposable.dispose();
      term.dispose();
      termRef.current = null;
      readyRef.current = false;
      bufferRef.current = [];
      bufferSizeRef.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Measure xterm's actual rendered DOM size AFTER resize and set the
  // mount to match exactly — with a safety pad so the last CJK glyph
  // doesn't get clipped by subpixel rounding when the font fallback
  // renders wide chars slightly wider than the grid cell.
  const syncMountToXterm = () => {
    const mount = mountRef.current;
    if (!mount) return;
    const xterm = mount.querySelector(".xterm") as HTMLElement | null;
    const screen = mount.querySelector(".xterm-screen") as HTMLElement | null;
    const rows = mount.querySelectorAll(".xterm-rows > div");
    let maxRowW = 0;
    rows.forEach((r) => {
      const el = r as HTMLElement;
      const rw = el.scrollWidth;
      if (rw > maxRowW) maxRowW = rw;
    });
    const w = Math.max(
      xterm?.scrollWidth ?? 0,
      xterm?.offsetWidth ?? 0,
      screen?.scrollWidth ?? 0,
      screen?.offsetWidth ?? 0,
      maxRowW,
    );
    const h = Math.max(
      xterm?.scrollHeight ?? 0,
      xterm?.offsetHeight ?? 0,
      screen?.scrollHeight ?? 0,
      screen?.offsetHeight ?? 0,
    );
    // Pad right by ~2 chars so last glyph never gets clipped.
    if (w > 0) mount.style.width = `${w + 24}px`;
    if (h > 0) mount.style.height = `${h + 8}px`;
  };

  useEffect(() => {
    const term = termRef.current;
    const outer = outerRef.current;
    const mount = mountRef.current;
    if (!term || !outer || !mount || !cols || !rows) return;
    try {
      term.resize(cols, rows);
    } catch { /* ignore */ }
    if (!readyRef.current) {
      readyRef.current = true;
      for (const b of bufferRef.current) {
        if (typeof b === "string") term.write(b);
        else term.write(new Uint8Array(b));
      }
      bufferRef.current = [];
      bufferSizeRef.current = 0;
    }

    // Force iOS Safari to actually paint the new geometry.
    //
    // Why this is necessary: when xterm.resize() updates the row buffer
    // and writes the post-attach pane content, Safari often defers the
    // paint of the freshly-mounted DOM rows until the user touches the
    // viewport. The visible symptom is "after `pocket attach`, content
    // shows up only after I swipe left/right on the phone." We can't
    // wait for that — apply three independent kicks that each force a
    // commit:
    //
    // 1. requestAnimationFrame x2 — gives xterm one frame to lay out,
    //    then re-measures (font metrics may settle on the second pass).
    // 2. term.refresh(0, term.rows-1) — repaints every visible row in
    //    the xterm buffer. Cheap; idempotent if nothing changed.
    // 3. transform-translateZ(0) toggle on the mount — promotes the
    //    element to a compositor layer briefly, which iOS treats as a
    //    repaint trigger. Equivalent to the classic "scrollLeft += 0"
    //    trick but more reliable on Safari.
    requestAnimationFrame(() => {
      syncMountToXterm();
      try { term.refresh(0, term.rows - 1); } catch { /* ignore */ }
      mount.style.transform = "translateZ(0)";
      // Read offsetHeight to flush layout before next frame.
      void mount.offsetHeight;
      requestAnimationFrame(() => {
        syncMountToXterm();
        try { term.refresh(0, term.rows - 1); } catch { /* ignore */ }
        mount.style.transform = "";
        if (outerRef.current) {
          outerRef.current.scrollTop = outerRef.current.scrollHeight;
        }
      });
    });
  }, [cols, rows]);

  // "Pull-down-at-top" gesture to reveal xterm scrollback (history above
  // the current Mac pane rows). When the user has scrolled the outer
  // container all the way to the top and continues to drag downward, we
  // consume the drag delta and call term.scrollLines(-N), exposing one
  // older row per ROW_H pixels of drag. "Pull-up-at-bottom" similarly
  // steps forward through scrollback back to the live tail.
  useEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;

    let lastY = 0;
    let tracking: "top" | "bottom" | null = null;

    const atTop = () => outer.scrollTop <= 2;
    const atBottom = () =>
      outer.scrollHeight - outer.scrollTop - outer.clientHeight <= 2;

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) { tracking = null; return; }
      lastY = e.touches[0].clientY;
      tracking = atTop() ? "top" : atBottom() ? "bottom" : null;
    };
    const onMove = (e: TouchEvent) => {
      if (!tracking || e.touches.length !== 1) return;
      const term = termRef.current;
      if (!term) return;
      const y = e.touches[0].clientY;
      const dy = y - lastY;
      if (tracking === "top" && atTop() && dy > 0) {
        const lines = Math.floor(dy / ROW_H);
        if (lines > 0) {
          term.scrollLines(-lines);
          lastY += lines * ROW_H;
        }
      } else if (tracking === "bottom" && atBottom() && dy < 0) {
        const lines = Math.floor(-dy / ROW_H);
        if (lines > 0) {
          term.scrollLines(lines);
          lastY -= lines * ROW_H;
        }
      } else {
        // Fell off the edge — let normal outer scroll take over; re-track
        // next time the edge is reached.
        tracking = null;
        lastY = y;
      }
    };
    const onEnd = () => { tracking = null; };

    outer.addEventListener("touchstart", onStart, { passive: true });
    outer.addEventListener("touchmove", onMove, { passive: true });
    outer.addEventListener("touchend", onEnd, { passive: true });
    outer.addEventListener("touchcancel", onEnd, { passive: true });

    return () => {
      outer.removeEventListener("touchstart", onStart);
      outer.removeEventListener("touchmove", onMove);
      outer.removeEventListener("touchend", onEnd);
      outer.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  // Initial rough placeholder while xterm is still laying out — the
  // useEffect above replaces these with measured values.
  const initialWidth = Math.max(Math.round(cols * CHAR_W) + 8, 100);
  const initialHeight = Math.max(Math.round(rows * ROW_H) + 4, 100);

  return (
    <div
      ref={outerRef}
      style={{
        position: "absolute",
        inset: 0,
        background: "#0b0d12",
        overflowX: "auto",
        overflowY: "auto",
        WebkitOverflowScrolling: "touch",
        touchAction: "manipulation",
        overscrollBehavior: "contain",
      }}
    >
      <div
        ref={mountRef}
        className="pocket-mount"
        style={{
          width: `${initialWidth}px`,
          height: `${initialHeight}px`,
          position: "relative",
          // Hint to Safari that this subtree paints frequently and should
          // live on its own compositor layer — eliminates the "blank
          // rectangle until I scroll/swipe" lazy-paint behaviour we hit
          // right after `pocket attach`.
          willChange: "transform, contents",
          contain: "layout paint",
        }}
      />
    </div>
  );
}
