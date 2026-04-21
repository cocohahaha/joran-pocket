import { useRef, useState } from "react";

interface Props {
  onSendLine: (text: string) => void;
  onSendKey: (key: string) => void;
}

// The primary input surface on phone. Users type multi-line prompts into the
// textarea (which uses native iOS input — voice dictation mic key works here),
// tap Send to flush the whole thing + \r to the Mac. The quick-keys row handles
// single-key events (arrows, Esc, Tab, y/n, Enter).
export function ComposeBar({ onSendLine, onSendKey }: Props) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const send = () => {
    const t = text;
    if (!t.length) return;
    onSendLine(t);
    setText("");
    ref.current?.focus();
  };

  return (
    <div style={styles.wrap}>
      <QuickKeys onKey={onSendKey} />
      <div style={styles.row}>
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="输入 prompt… 点右侧 ➤ 发送"
          rows={1}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          style={styles.textarea}
          onInput={(e) => autoGrow(e.currentTarget)}
        />
        <button
          style={{ ...styles.send, opacity: text.length ? 1 : 0.4 }}
          onClick={send}
          disabled={!text.length}
          aria-label="Send"
        >
          ➤
        </button>
      </div>
    </div>
  );
}

function QuickKeys({ onKey }: { onKey: (k: string) => void }) {
  const keys: Array<{ label: string; key: string }> = [
    { label: "⎋", key: "\x1b" },    // Esc
    { label: "⇥", key: "\t" },      // Tab
    { label: "↑", key: "\x1b[A" },
    { label: "↓", key: "\x1b[B" },
    { label: "←", key: "\x1b[D" },
    { label: "→", key: "\x1b[C" },
    { label: "⏎", key: "\r" },
    { label: "Ctrl-C", key: "\x03" },
  ];
  return (
    <div style={styles.qkRow}>
      {keys.map((k) => (
        <button key={k.label} style={styles.qkBtn} onClick={() => onKey(k.key)}>
          {k.label}
        </button>
      ))}
    </div>
  );
}

function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = Math.min(140, el.scrollHeight) + "px";
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    background: "linear-gradient(to top, var(--surface) 0%, var(--surface) 80%, rgba(17,19,25,0.9) 100%)",
    borderTop: "1px solid var(--border)",
    paddingBottom: "max(env(safe-area-inset-bottom), 8px)",
  },
  qkRow: {
    display: "flex",
    overflowX: "auto",
    gap: 6,
    padding: "8px 10px",
    scrollbarWidth: "none",
  },
  qkBtn: {
    flex: "0 0 auto",
    minWidth: 44,
    padding: "9px 12px",
    background: "var(--surface-elev)",
    borderRadius: 8,
    color: "var(--accent)",
    fontFamily: "var(--font-mono)",
    fontSize: 14,
    fontWeight: 600,
    border: "1px solid var(--border)",
  },
  row: {
    display: "flex",
    alignItems: "flex-end",
    gap: 8,
    padding: "6px 10px 10px",
  },
  textarea: {
    flex: 1,
    minHeight: 40,
    maxHeight: 140,
    padding: "10px 12px",
    background: "var(--surface-elev)",
    borderRadius: 12,
    border: "1px solid var(--border)",
    fontSize: 15,
    lineHeight: 1.4,
    color: "var(--text)",
    resize: "none",
  },
  send: {
    width: 44,
    height: 44,
    borderRadius: 12,
    background: "var(--accent)",
    color: "#0b0d12",
    fontSize: 20,
    fontWeight: 700,
    flexShrink: 0,
  },
};
