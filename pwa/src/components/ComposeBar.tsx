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
    if (!t.length) {
      // Empty textarea: treat as plain Enter submit. Handles the case
      // where the user typed directly into Claude via a remote keyboard
      // (or the textarea glitched out) — tapping ➤ should still push
      // the current terminal line just like Enter does on a real keyboard.
      onSendKey("\r");
      return;
    }
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
          style={styles.send}
          onClick={send}
          aria-label={text.length ? "Send prompt" : "Send Enter"}
        >
          {text.length ? "➤" : "⏎"}
        </button>
      </div>
    </div>
  );
}

function QuickKeys({ onKey }: { onKey: (k: string) => void }) {
  // Row 1: Claude Code power keys + core nav. Shift-Tab cycles Claude's mode
  // (plan / accept-edits / default) which is the most-used shortcut.
  const row1: Array<{ label: string; key: string; hint?: string; wide?: boolean }> = [
    { label: "⇧⇥", key: "\x1b[Z", hint: "Shift+Tab  Claude 切模式", wide: true },
    { label: "⎋",  key: "\x1b",   hint: "Esc 取消" },
    { label: "⇥",  key: "\t",     hint: "Tab 补全" },
    { label: "⏎",  key: "\r",     hint: "Enter 回车" },
    { label: "⌫",  key: "\x7f",   hint: "退格" },
    { label: "^C", key: "\x03",   hint: "Ctrl-C 中断" },
    { label: "^D", key: "\x04",   hint: "Ctrl-D EOF" },
    { label: "^L", key: "\x0c",   hint: "Ctrl-L 清屏" },
  ];
  // Row 2: cursor navigation.
  const row2: Array<{ label: string; key: string }> = [
    { label: "↑", key: "\x1b[A" },
    { label: "↓", key: "\x1b[B" },
    { label: "←", key: "\x1b[D" },
    { label: "→", key: "\x1b[C" },
    { label: "Home", key: "\x1b[H" },
    { label: "End",  key: "\x1b[F" },
    { label: "PgUp", key: "\x1b[5~" },
    { label: "PgDn", key: "\x1b[6~" },
  ];
  return (
    <>
      <div style={styles.qkRow}>
        {row1.map((k) => (
          <button
            key={k.label}
            style={{ ...styles.qkBtn, ...(k.wide ? styles.qkBtnWide : null) }}
            onClick={() => onKey(k.key)}
            aria-label={k.hint ?? k.label}
          >
            {k.label}
          </button>
        ))}
      </div>
      <div style={styles.qkRow}>
        {row2.map((k) => (
          <button key={k.label} style={styles.qkBtn} onClick={() => onKey(k.key)}>
            {k.label}
          </button>
        ))}
      </div>
    </>
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
    padding: "6px 10px",
    scrollbarWidth: "none",
  },
  qkBtn: {
    flex: "0 0 auto",
    minWidth: 44,
    padding: "10px 12px",
    background: "var(--surface-elev)",
    borderRadius: 8,
    color: "var(--accent)",
    fontFamily: "var(--font-mono)",
    fontSize: 14,
    fontWeight: 600,
    border: "1px solid var(--border)",
  },
  qkBtnWide: {
    // Prominent "Shift+Tab / cycle mode" since that's the most-requested
    // Claude Code shortcut.
    minWidth: 64,
    background: "rgba(249, 115, 22, 0.18)",
    color: "var(--accent)",
    borderColor: "rgba(249, 115, 22, 0.5)",
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
