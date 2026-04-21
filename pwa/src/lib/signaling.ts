// Signaling client for the PWA (guest) side.
// Connects to the same Cloudflare Worker the Mac helper registers with;
// relays SDP / ICE messages. Does not touch terminal bytes.

export type SignalingMsg =
  | { type: "hello"; role: "host" | "guest" }
  | { type: "peer-joined"; role: "host" | "guest" }
  | { type: "peer-left"; role: "host" | "guest" }
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: RTCIceCandidateInit }
  | { type: "done" }
  | { type: "pong" };

export interface SignalingCallbacks {
  onHello?: (role: "host" | "guest") => void;
  onPeerJoined?: (role: "host" | "guest") => void;
  onPeerLeft?: (role: "host" | "guest") => void;
  onOffer?: (sdp: string) => void;
  onAnswer?: (sdp: string) => void;
  onIce?: (c: RTCIceCandidateInit) => void;
  onDone?: () => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (e: Event) => void;
}

export class Signaling {
  private ws: WebSocket | null = null;
  private cbs: SignalingCallbacks;
  private wssURL: string;
  private queue: SignalingMsg[] = [];

  constructor(wssURL: string, cbs: SignalingCallbacks) {
    this.wssURL = wssURL;
    this.cbs = cbs;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wssURL);
      this.ws = ws;

      ws.addEventListener("open", () => {
        // Flush anything queued before open.
        for (const m of this.queue) ws.send(JSON.stringify(m));
        this.queue = [];
        resolve();
      });
      ws.addEventListener("message", (e) => {
        try {
          const msg = JSON.parse(e.data as string) as SignalingMsg;
          this.dispatch(msg);
        } catch {
          /* ignore malformed */
        }
      });
      ws.addEventListener("close", (e) => {
        this.cbs.onClose?.(e.code, e.reason);
      });
      ws.addEventListener("error", (e) => {
        this.cbs.onError?.(e);
        reject(e);
      });
    });
  }

  private dispatch(m: SignalingMsg) {
    switch (m.type) {
      case "hello":      this.cbs.onHello?.(m.role); break;
      case "peer-joined": this.cbs.onPeerJoined?.(m.role); break;
      case "peer-left":  this.cbs.onPeerLeft?.(m.role); break;
      case "offer":      this.cbs.onOffer?.(m.sdp); break;
      case "answer":     this.cbs.onAnswer?.(m.sdp); break;
      case "ice":        this.cbs.onIce?.(m.candidate); break;
      case "done":       this.cbs.onDone?.(); break;
      case "pong":       /* ignore */ break;
    }
  }

  send(m: SignalingMsg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(m));
    } else {
      this.queue.push(m);
    }
  }

  close() {
    if (this.ws) {
      try { this.ws.close(1000, "done"); } catch {}
      this.ws = null;
    }
  }
}
