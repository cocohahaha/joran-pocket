interface Props {
  prompt: string;
  onAllow: () => void;
  onDeny: () => void;
}

// Rises up from the bottom when the sidechannel reports Claude Code is
// waiting for a y/n. Big finger-sized buttons — avoid the fiddly phone
// keyboard for single-key approvals.
export function ApprovalSheet({ prompt, onAllow, onDeny }: Props) {
  return (
    <div style={styles.overlay}>
      <div style={styles.sheet}>
        <div style={styles.tag}>Claude 正在等你确认</div>
        <div style={styles.prompt}>{prompt || "继续？"}</div>
        <div style={styles.row}>
          <button style={{ ...styles.btn, ...styles.deny }} onClick={onDeny}>
            <span style={styles.btnIcon}>✗</span>
            <span>拒绝 (n)</span>
          </button>
          <button style={{ ...styles.btn, ...styles.allow }} onClick={onAllow}>
            <span style={styles.btnIcon}>✓</span>
            <span>同意 (y)</span>
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "absolute",
    inset: 0,
    background: "rgba(0, 0, 0, 0.6)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    zIndex: 100,
    display: "flex",
    alignItems: "flex-end",
  },
  sheet: {
    width: "100%",
    background: "var(--surface)",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: "24px 20px max(env(safe-area-inset-bottom), 20px)",
    borderTop: "2px solid var(--accent)",
    boxShadow: "0 -20px 40px rgba(249, 115, 22, 0.15)",
  },
  tag: {
    color: "var(--accent)",
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    marginBottom: 12,
  },
  prompt: {
    color: "var(--text)",
    fontSize: 17,
    lineHeight: 1.4,
    marginBottom: 24,
    fontFamily: "var(--font-mono)",
  },
  row: { display: "flex", gap: 12 },
  btn: {
    flex: 1,
    padding: "16px",
    borderRadius: 14,
    fontSize: 16,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  btnIcon: { fontSize: 18, fontWeight: 900 },
  allow: { background: "var(--ok)", color: "#0b0d12" },
  deny: { background: "var(--surface-elev)", color: "var(--danger)", border: "1px solid rgba(239,68,68,0.3)" },
};
