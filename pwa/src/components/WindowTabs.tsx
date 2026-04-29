import { useState } from "react";

export interface PocketWindow {
  index: number;
  name: string;
  active: boolean;
  panes: number;
}

interface Props {
  windows: PocketWindow[];
  onSelect: (index: number) => void;
  onNew: () => void;
  onRename: (index: number, newName: string) => void;
  onClose: (index: number) => void;
}

// Horizontal tab strip mirroring tmux's window list. Tap a tab to switch;
// long-press to rename / close. Updates in both directions — Mac-side
// changes (new window in a Terminal tab) show up here within ~1s.
export function WindowTabs({ windows, onSelect, onNew, onRename, onClose }: Props) {
  const [menuFor, setMenuFor] = useState<number | null>(null);

  if (windows.length === 0) {
    return (
      <div style={styles.bar}>
        <span style={styles.empty}>等待 tmux 窗口列表…</span>
      </div>
    );
  }

  return (
    <div style={styles.bar}>
      <div style={styles.scroller}>
        {windows.map((w) => {
          const isActive = w.active;
          const long = useLongPress(() => setMenuFor(w.index));
          return (
            <div key={w.index} style={styles.tabWrap}>
              <button
                style={{
                  ...styles.tab,
                  ...(isActive ? styles.tabActive : null),
                }}
                onClick={() => onSelect(w.index)}
                {...long}
              >
                <span style={styles.idx}>{w.index}</span>
                <span style={styles.name}>{w.name}</span>
                {w.panes > 1 && <span style={styles.panes}>·{w.panes}</span>}
              </button>
              {menuFor === w.index && (
                <TabMenu
                  window={w}
                  onClose={() => setMenuFor(null)}
                  onRename={(n) => { onRename(w.index, n); setMenuFor(null); }}
                  onKill={() => { onClose(w.index); setMenuFor(null); }}
                />
              )}
            </div>
          );
        })}
        <button style={styles.newBtn} onClick={onNew} aria-label="new window">
          +
        </button>
      </div>
    </div>
  );
}

function useLongPress(callback: () => void) {
  let timer: number | null = null;
  const clear = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  return {
    onTouchStart: () => { clear(); timer = window.setTimeout(callback, 500); },
    onTouchEnd: clear,
    onTouchMove: clear,
    onTouchCancel: clear,
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); callback(); },
  };
}

function TabMenu({
  window,
  onClose,
  onRename,
  onKill,
}: {
  window: PocketWindow;
  onClose: () => void;
  onRename: (name: string) => void;
  onKill: () => void;
}) {
  const [name, setName] = useState(window.name);
  return (
    <div style={styles.menuOverlay} onClick={onClose}>
      <div style={styles.menu} onClick={(e) => e.stopPropagation()}>
        <div style={styles.menuTitle}>窗口 #{window.index}</div>
        <label style={styles.menuLabel}>
          名字
          <input
            style={styles.menuInput}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            onKeyDown={(e) => e.key === "Enter" && onRename(name)}
          />
        </label>
        <div style={styles.menuRow}>
          <button style={{ ...styles.menuBtn, ...styles.menuBtnPrimary }} onClick={() => onRename(name)}>
            改名
          </button>
          <button style={{ ...styles.menuBtn, ...styles.menuBtnDanger }} onClick={onKill}>
            关闭窗口
          </button>
          <button style={styles.menuBtn} onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    position: "absolute",
    top: 44,
    left: 0,
    right: 0,
    height: 40,
    background: "var(--surface)",
    borderBottom: "1px solid var(--border)",
    zIndex: 5,
  },
  scroller: {
    height: "100%",
    display: "flex",
    alignItems: "center",
    overflowX: "auto",
    overflowY: "hidden",
    scrollbarWidth: "none",
    padding: "0 6px",
    gap: 4,
  },
  tabWrap: { position: "relative", flex: "0 0 auto" },
  tab: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "7px 12px",
    background: "var(--surface-elev)",
    borderRadius: 8,
    color: "var(--text-dim)",
    fontSize: 13,
    lineHeight: 1,
    border: "1px solid var(--border)",
    minHeight: 28,
  },
  tabActive: {
    background: "var(--accent)",
    color: "#0b0d12",
    borderColor: "var(--accent)",
    fontWeight: 600,
  },
  idx: { fontFamily: "var(--font-mono)", fontSize: 11, opacity: 0.7 },
  name: { fontSize: 13 },
  panes: { fontFamily: "var(--font-mono)", fontSize: 11, opacity: 0.7 },
  newBtn: {
    flex: "0 0 auto",
    width: 32,
    height: 28,
    background: "transparent",
    border: "1px dashed var(--border)",
    borderRadius: 8,
    color: "var(--accent)",
    fontSize: 18,
    lineHeight: 1,
    fontWeight: 600,
  },
  empty: {
    color: "var(--text-muted)",
    fontSize: 12,
    padding: "0 14px",
    lineHeight: "40px",
  },
  menuOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    backdropFilter: "blur(4px)",
    zIndex: 50,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  menu: {
    width: "100%",
    maxWidth: 320,
    background: "var(--surface)",
    borderRadius: 14,
    padding: 18,
    border: "1px solid var(--border)",
  },
  menuTitle: {
    color: "var(--accent)",
    fontSize: 12,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    marginBottom: 12,
    fontWeight: 700,
  },
  menuLabel: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    color: "var(--text-dim)",
    fontSize: 12,
    marginBottom: 14,
  },
  menuInput: {
    padding: "10px 12px",
    background: "var(--surface-elev)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    color: "var(--text)",
    fontSize: 15,
  },
  menuRow: { display: "flex", gap: 8, flexWrap: "wrap" },
  menuBtn: {
    flex: "1 1 auto",
    padding: "10px 12px",
    background: "var(--surface-elev)",
    borderRadius: 8,
    color: "var(--text-dim)",
    fontSize: 13,
    fontWeight: 500,
    border: "1px solid var(--border)",
  },
  menuBtnPrimary: { background: "var(--accent)", color: "#0b0d12", borderColor: "var(--accent)" },
  menuBtnDanger:  { background: "rgba(239,68,68,0.12)", color: "var(--danger)", borderColor: "rgba(239,68,68,0.35)" },
};
