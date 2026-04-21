import { useCallback, useEffect, useRef, useState } from "react";
import { PairView } from "./components/PairView.tsx";
import { TerminalView } from "./components/Terminal.tsx";
import { ComposeBar } from "./components/ComposeBar.tsx";
import { ApprovalSheet } from "./components/ApprovalSheet.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { Signaling } from "./lib/signaling.ts";
import { Peer } from "./lib/webrtc.ts";
import { getSignalingHost, buildPairWssURL, parseCodeFromLocation } from "./lib/config.ts";

type Phase = "pair" | "connecting" | "connected" | "disconnected" | "failed";

interface ClaudeEvent {
  type: "awaiting_approval" | "executing_bash" | "diff_ready" | "idle";
  text?: string;
  at: number;
}

export default function App() {
  const [phase, setPhase] = useState<Phase>("pair");
  const [code, setCode] = useState<string | null>(parseCodeFromLocation());
  const [pairError, setPairError] = useState<string | null>(null);
  const [claudeState, setClaudeState] = useState<ClaudeEvent | null>(null);

  const signalingRef = useRef<Signaling | null>(null);
  const peerRef = useRef<Peer | null>(null);
  const writeToTermRef = useRef<((b: ArrayBuffer | string) => void) | null>(null);

  // Auto-start pairing if URL had a /p/CODE path.
  useEffect(() => {
    if (code && phase === "pair") startPair(code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startPair = useCallback((codeInput: string) => {
    setPairError(null);
    setPhase("connecting");

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

    const peer = new Peer({
      onPtyBytes: (buf) => writeToTermRef.current?.(buf),
      onPtyString: (s) => writeToTermRef.current?.(s),
      onSidechannelEvent: (ev) => {
        const e = ev as ClaudeEvent;
        if (!e || !e.type) return;
        setClaudeState(e);
      },
      onStateChange: (s) => {
        if (s === "connected") setPhase("connected");
        if (s === "failed") setPhase("failed");
        if (s === "disconnected" || s === "closed") setPhase("disconnected");
      },
      onIce: (c) => signalingRef.current?.send({ type: "ice", candidate: c }),
    });
    peerRef.current = peer;

    const signaling = new Signaling(wssURL, {
      onOffer: async (sdp) => {
        const answer = await peer.acceptOffer(sdp);
        signaling.send({ type: "answer", sdp: answer.sdp! });
      },
      onIce: (c) => {
        peer.addIce(c);
      },
      onPeerLeft: () => {
        setPhase("disconnected");
      },
      onError: () => {
        setPairError("信令连接失败。检查配对码/网络再试。");
        setPhase("pair");
      },
      onClose: (code, reason) => {
        if (phase !== "connected") {
          setPairError(`信令已断开 (${code}${reason ? ": " + reason : ""})`);
          setPhase("pair");
        }
      },
    });
    signalingRef.current = signaling;

    signaling.connect().catch((e) => {
      setPairError(String(e?.message ?? e ?? "connect failed"));
      setPhase("pair");
    });
  }, [phase]);

  const disconnect = useCallback(() => {
    peerRef.current?.close();
    signalingRef.current?.close();
    peerRef.current = null;
    signalingRef.current = null;
    setPhase("pair");
    setClaudeState(null);
    // Return URL to /pair so a reload doesn't re-trigger auto-pair.
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
        connectionState={phase === "connecting" ? "connecting" : phase === "connected" ? "connected" : "disconnected"}
        onDisconnect={disconnect}
      />
      <div style={{ position: "absolute", top: 44, bottom: 220, left: 0, right: 0 }}>
        <TerminalView
          onData={(d) => peerRef.current?.sendInput(d)}
          onResize={(cols, rows) => peerRef.current?.sendResize(cols, rows)}
          registerWriter={(w) => { writeToTermRef.current = w; }}
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
    </>
  );
}
