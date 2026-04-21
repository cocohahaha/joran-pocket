import { useState, useCallback } from "react";

interface Props {
  initialCode: string | null;
  onPair: (code: string) => void;
  error?: string | null;
}

export function PairView({ initialCode, onPair, error }: Props) {
  const [code, setCode] = useState(initialCode ?? "");

  const submit = useCallback(() => {
    const cleaned = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (cleaned.length >= 4) onPair(cleaned);
  }, [code, onPair]);

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.logo}>
          <span style={{ color: "var(--accent)", fontWeight: 700, letterSpacing: "0.2em" }}>
            JORAN
          </span>{" "}
          POCKET
        </div>
        <div style={styles.tagline}>在你 Mac 的终端里输 <code style={styles.inline}>pocket</code> 获取配对码</div>

        <label style={styles.label}>
          <span>6 位配对码</span>
          <input
            style={styles.input}
            placeholder="ABC123"
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            maxLength={8}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </label>

        <button style={styles.btn} onClick={submit} disabled={code.trim().length < 4}>
          连接
        </button>

        {error && <div style={styles.error}>{error}</div>}

        <div style={styles.hint}>
          配对码 5 分钟内有效。不分享这个码给别人。
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100dvh",
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "max(env(safe-area-inset-top), 24px) 20px max(env(safe-area-inset-bottom), 24px)",
    background: "radial-gradient(ellipse at top, #1a1d25 0%, #0b0d12 60%)",
  },
  card: {
    width: "100%",
    maxWidth: 360,
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  logo: {
    fontSize: 20,
    letterSpacing: "0.08em",
    color: "var(--text)",
    marginBottom: 4,
  },
  tagline: {
    color: "var(--text-dim)",
    fontSize: 14,
    lineHeight: 1.5,
    marginBottom: 16,
  },
  inline: {
    background: "var(--surface-elev)",
    padding: "2px 6px",
    borderRadius: 4,
    color: "var(--accent)",
    fontFamily: "var(--font-mono)",
    fontSize: 13,
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    color: "var(--text-dim)",
    fontSize: 13,
    fontWeight: 500,
  },
  input: {
    fontSize: 32,
    fontFamily: "var(--font-mono)",
    fontWeight: 600,
    letterSpacing: "0.25em",
    textAlign: "center",
    padding: "18px 16px",
    background: "var(--surface)",
    borderRadius: 12,
    border: "1px solid var(--border)",
    color: "var(--text)",
  },
  btn: {
    padding: "16px",
    fontSize: 16,
    fontWeight: 600,
    background: "var(--accent)",
    color: "#0b0d12",
    borderRadius: 12,
    marginTop: 4,
  },
  error: {
    padding: "12px 14px",
    background: "rgba(239, 68, 68, 0.1)",
    color: "var(--danger)",
    border: "1px solid rgba(239, 68, 68, 0.3)",
    borderRadius: 10,
    fontSize: 13,
  },
  hint: {
    color: "var(--text-muted)",
    fontSize: 12,
    textAlign: "center",
    marginTop: 12,
  },
};
