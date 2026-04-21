import { useEffect, useRef } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

interface Props {
  onData: (s: string) => void;
  onResize: (cols: number, rows: number) => void;
  registerWriter: (writeBytes: (b: ArrayBuffer | string) => void) => void;
}

// The xterm.js-rendered terminal view. Read/write is controlled externally:
//  - xterm bytes FROM the Mac arrive via `registerWriter` (we expose a writer)
//  - user keystrokes in the terminal (rare on phone — compose bar is primary)
//    flow out through `onData`
export function TerminalView({ onData, onResize, registerWriter }: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const el = mountRef.current!;
    const term = new XTerminal({
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 5000,
      macOptionIsMeta: true,
      allowTransparency: false,
      convertEol: false,
      disableStdin: false,
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

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    term.onData(onData);
    const writer = (b: ArrayBuffer | string) => {
      if (typeof b === "string") term.write(b);
      else term.write(new Uint8Array(b));
    };
    registerWriter(writer);

    const notifyResize = () => {
      try {
        fit.fit();
        onResize(term.cols, term.rows);
      } catch { /* initial mount race */ }
    };

    const ro = new ResizeObserver(() => {
      // debounce a bit so rapid layout shifts don't spam
      notifyResize();
    });
    ro.observe(el);

    // Initial size push.
    notifyResize();

    return () => {
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={mountRef}
      style={{
        position: "absolute",
        inset: 0,
        background: "var(--bg)",
      }}
    />
  );
}
