interface Props {
  connectionState: "connecting" | "authenticating" | "connected" | "reconnecting" | "disconnected" | "failed";
  onDisconnect: () => void;
}

export function StatusBar({ connectionState, onDisconnect }: Props) {
  const dot = {
    connecting: "var(--accent)",
    authenticating: "var(--accent)",
    connected: "var(--ok)",
    reconnecting: "var(--accent)",
    disconnected: "var(--text-muted)",
    failed: "var(--danger)",
  }[connectionState];

  const label = {
    connecting: "连接中…",
    authenticating: "认证中…",
    connected: "已连接",
    reconnecting: "重连中…",
    disconnected: "已断开",
    failed: "连接失败",
  }[connectionState];

  return (
    <div style={styles.bar}>
      <div style={{ ...styles.dot, background: dot }} />
      <span style={styles.label}>{label}</span>
      <span style={{ flex: 1 }} />
      <button style={styles.btn} onClick={onDisconnect}>
        断开
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "max(env(safe-area-inset-top), 10px) 14px 10px",
    background: "var(--surface)",
    borderBottom: "1px solid var(--border)",
    fontSize: 13,
    zIndex: 10,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 999,
  },
  label: {
    color: "var(--text-dim)",
  },
  btn: {
    padding: "6px 12px",
    background: "var(--surface-elev)",
    color: "var(--text-dim)",
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 500,
  },
};
