import { useCallback, useEffect, useRef, useState } from "react";
import { PairView } from "./components/PairView.tsx";
import { TerminalView } from "./components/Terminal.tsx";
import { ComposeBar } from "./components/ComposeBar.tsx";
import { ApprovalSheet } from "./components/ApprovalSheet.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { WindowTabs, PocketWindow } from "./components/WindowTabs.tsx";
import { Signaling } from "./lib/signaling.ts";
import { Peer } from "./lib/webrtc.ts";
import { getSignalingHost, buildPairWssURL, parseCodeFromLocation } from "./lib/config.ts";

type Phase = "pair" | "connecting" | "connected" | "reconnecting" | "disconnected" | "failed";

interface ClaudeEvent {
  type: "awaiting_approval" | "executing_bash" | "diff_ready" | "idle";
  text?: string;
  at: number;
}

interface WindowsEvent {
  type: "windows";
  windows: PocketWindow[];
  active_index: number;
  at: number;
}

interface PaneSizeEvent {
  type: "pane_size";
  cols: number;
  rows: number;
  at: number;
}

export default function App() {
  const [phase, setPhase] = useState<Phase>("pair");
  const [code, setCode] = useState<string | null>(parseCodeFromLocation());
  const [pairError, setPairError] = useState<string | null>(null);
  const [claudeState, setClaudeState] = useState<ClaudeEvent | null>(null);
  const [windows, setWindows] = useState<PocketWindow[]>([]);
  const [paneCols, setPaneCols] = useState<number>(42);
  const [paneRows, setPaneRows] = useState<number>(20);
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const debugLogRef = useRef<string[]>([]);
  const dbg = useCallback((msg: string) => {
    const line = `${new Date().toISOString().slice(11, 23)} ${msg}`;
    console.log("[pocket]", line);
    debugLogRef.current = [...debugLogRef.current, line].slice(-20);
    setDebugLog(debugLogRef.current);
  }, []);

  const signalingRef = useRef<Signaling | null>(null);
  const peerRef = useRef<Peer | null>(null);
  const writeToTermRef = useRef<((b: ArrayBuffer | string) => void) | null>(null);
  const autoReconnectRef = useRef(true);
  const currentCodeRef = useRef<string | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const phaseRef = useRef<Phase>("pair");
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // Auto-start pairing if URL had a /p/CODE path.
  useEffect(() => {
    if (code && phase === "pair") startPair(code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // iOS Safari tab suspension recovery — only kick a fresh startPair when
  // the PC is actually dead. Triggering during the initial handshake
  // (pc="new" or "connecting") would tear down the in-flight signaling
  // and restart forever — that's what caused the earlier reconnect loop.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      if (!autoReconnectRef.current || !currentCodeRef.current) return;
      const pc = peerRef.current?.pc;
      if (!pc) return;
      const s = pc.connectionState;
      if (s !== "failed" && s !== "closed" && s !== "disconnected") return;
      dbg(`visibility kick (pc=${s})`);
      if (retryTimerRef.current !== null) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
      startPair(currentCodeRef.current);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleRetry = useCallback((delayMs: number) => {
    if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      if (autoReconnectRef.current && currentCodeRef.current) {
        startPair(currentCodeRef.current);
      }
    }, delayMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startPair = useCallback((codeInput: string) => {
    if (peerRef.current) { try { peerRef.current.close(); } catch {} peerRef.current = null; }
    if (signalingRef.current) { try { signalingRef.current.close(); } catch {} signalingRef.current = null; }
    if (retryTimerRef.current !== null) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }

    autoReconnectRef.current = true;
    currentCodeRef.current = codeInput;

    setPairError(null);
    const prev = phaseRef.current;
    setPhase(prev === "connected" || prev === "reconnecting" ? "reconnecting" : "connecting");

    setPaneCols(42);
    setPaneRows(20);

    let signalingBase: string;
    try {
      signalingBase = getSignalingHost();
    } catch (e: any) {
      setPairError(e?.message ?? "signaling host not configured");
      setPhase("pair");
      return;
    }

    const wssURL = buildPairWssURL(signalingBase, codeInput);
    setCode(codeInput);

    dbg(`startPair(${codeInput})`);

    const peer = new Peer({
      onPtyBytes: (buf) => writeToTermRef.current?.(buf),
      onPtyString: (s) => writeToTermRef.current?.(s),
      onSidechannelEvent: (ev) => {
        const e = ev as { type?: string } | null;
        if (!e || !e.type) return;
        dbg(`side evt: ${e.type}`);
        if (e.type === "windows") {
          const we = ev as WindowsEvent;
          setWindows(we.windows);
          return;
        }
        if (e.type === "pane_size") {
          const pe = ev as PaneSizeEvent;
          if (pe.cols > 0 && pe.rows > 0) {
            setPaneCols(pe.cols);
            setPaneRows(pe.rows);
          }
          return;
        }
        setClaudeState(ev as ClaudeEvent);
      },
      onStateChange: (s) => {
        dbg(`pc state: ${s} (ice=${peerRef.current?.pc.iceConnectionState})`);
        if (s === "connected") {
          setPhase("connected");
          return;
        }
        if (s === "failed" || s === "closed") {
          if (autoReconnectRef.current && currentCodeRef.current) {
            setPhase("reconnecting");
            scheduleRetry(2000);
          } else {
            setPhase(s === "failed" ? "failed" : "disconnected");
          }
        }
      },
      onIce: (c) => signalingRef.current?.send({ type: "ice", candidate: c }),
      onDataChannelOpen: (label) => {
        dbg(`DC open: ${label}`);
      },
    });
    peerRef.current = peer;

    const signaling = new Signaling(wssURL, {
      onOpen: () => dbg(`signaling ws open`),
      onAnyMessage: (t) => dbg(`signaling rx: ${t}`),
      onOffer: async (sdp) => {
        dbg(`offer received (sdp ${sdp.length} bytes)`);
        try {
          const answer = await peer.acceptOffer(sdp);
          dbg(`answer created (sdp ${answer.sdp?.length ?? 0} bytes)`);
          signaling.send({ type: "answer", sdp: answer.sdp! });
        } catch (e: any) {
          dbg(`acceptOffer error: ${e?.message ?? e}`);
        }
      },
      onIce: (c) => {
        peer.addIce(c);
      },
      onPeerLeft: (role) => {
        dbg(`peer-left role=${role}`);
        if (role === "host") {
          setPhase("disconnected");
        }
      },
      onError: () => {
        dbg(`signaling error`);
        if (!autoReconnectRef.current || !currentCodeRef.current) {
          setPairError("信令连接失败。检查配对码/网络再试。");
          setPhase("pair");
        }
      },
      onClose: (c, reason) => {
        dbg(`signaling closed code=${c} reason=${reason || "(empty)"} pc=${peerRef.current?.pc.connectionState}`);
        if (!autoReconnectRef.current || !currentCodeRef.current) return;
        if (peerRef.current?.pc.connectionState !== "connected") {
          setPhase("reconnecting");
          scheduleRetry(2000);
        }
      },
    });
    signalingRef.current = signaling;

    signaling.connect().catch((e) => {
      if (!autoReconnectRef.current) {
        setPairError(String(e?.message ?? e ?? "connect failed"));
        setPhase("pair");
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleRetry, dbg]);

  const controlSend = useCallback((msg: object) => {
    peerRef.current?.sendControl(msg);
  }, []);
  const selectWindow = useCallback((index: number) => controlSend({ type: "select_window", index }), [controlSend]);
  const newWindow    = useCallback(() => controlSend({ type: "new_window" }), [controlSend]);
  const killWindow   = useCallback((index: number) => controlSend({ type: "kill_window", index }), [controlSend]);
  const renameWindow = useCallback((index: number, name: string) => controlSend({ type: "rename_window", index, name }), [controlSend]);

  const disconnect = useCallback(() => {
    autoReconnectRef.current = false;
    currentCodeRef.current = null;
    if (retryTimerRef.current !== null) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
    peerRef.current?.close();
    signalingRef.current?.close();
    peerRef.current = null;
    signalingRef.current = null;
    setPhase("pair");
    setClaudeState(null);
    if (window.location.pathname !== "/") {
      window.history.replaceState({}, "", "/");
    }
  }, []);

  const sendKey = useCallback((k: string) => {
    peerRef.current?.sendInput(k);
  }, []);
  const sendLine = useCallback((t: string) => {
    peerRef.current?.sendInput(t + "\r");
  }, []);

  if (phase === "pair" || phase === "failed") {
    return (
      <PairView
        initialCode={code}
        onPair={startPair}
        error={pairError}
      />
    );
  }

  const awaiting = claudeState?.type === "awaiting_approval";

  return (
    <>
      <StatusBar
        connectionState={
          phase === "connecting" ? "connecting" :
          phase === "reconnecting" ? "reconnecting" :
          phase === "connected" ? "connected" : "disconnected"
        }
        onDisconnect={disconnect}
      />
      <WindowTabs
        windows={windows}
        onSelect={selectWindow}
        onNew={newWindow}
        onClose={killWindow}
        onRename={renameWindow}
      />
      <div style={{ position: "absolute", top: 84, bottom: 260, left: 0, right: 0 }}>
        <TerminalView
          onData={(d) => peerRef.current?.sendInput(d)}
          registerWriter={(w) => { writeToTermRef.current = w; }}
          cols={paneCols}
          rows={paneRows}
        />
      </div>
      <ComposeBar onSendLine={sendLine} onSendKey={sendKey} />
      {awaiting && claudeState && (
        <ApprovalSheet
          prompt={claudeState.text ?? ""}
          onAllow={() => { sendKey("y"); sendKey("\r"); setClaudeState({ type: "idle", at: Date.now() }); }}
          onDeny={() => { sendKey("n"); sendKey("\r"); setClaudeState({ type: "idle", at: Date.now() }); }}
        />
      )}
      <DebugOverlay log={debugLog} />
    </>
  );
}

function DebugOverlay({ log }: { log: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "fixed", top: 8, right: 8, zIndex: 100, fontSize: 10 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          background: "rgba(249,115,22,0.15)",
          color: "var(--accent)",
          border: "1px solid rgba(249,115,22,0.4)",
          borderRadius: 6,
          padding: "3px 8px",
          fontSize: 10,
          fontWeight: 600,
        }}
      >
        {open ? "✕" : "DBG"}
      </button>
      {open && (
        <div
          style={{
            marginTop: 4,
            maxHeight: 260,
            width: 320,
            overflow: "auto",
            background: "rgba(11,13,18,0.95)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 8,
            color: "var(--text-dim)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            lineHeight: 1.4,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {log.length === 0 ? "(empty)" : log.join("\n")}
        </div>
      )}
    </div>
  );
}
