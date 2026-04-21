// WebRTC peer wiring for the PWA (guest) side.
// The Mac helper (host) creates the DataChannels (pty + sidechannel); we
// receive them via the ondatachannel callback after accepting the offer.

export interface PeerCallbacks {
  onPtyBytes?: (data: ArrayBuffer) => void;
  onPtyString?: (text: string) => void;
  onSidechannelEvent?: (ev: unknown) => void;
  onStateChange?: (state: RTCPeerConnectionState) => void;
  onIce?: (c: RTCIceCandidateInit) => void;
  onDataChannelOpen?: (label: string) => void;
  onDataChannelClose?: (label: string) => void;
}

export class Peer {
  pc: RTCPeerConnection;
  private pty: RTCDataChannel | null = null;
  private side: RTCDataChannel | null = null;
  private cbs: PeerCallbacks;

  constructor(cbs: PeerCallbacks) {
    this.cbs = cbs;
    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun.cloudflare.com:3478" },
      ],
    });
    this.pc.addEventListener("icecandidate", (e) => {
      if (e.candidate) cbs.onIce?.(e.candidate.toJSON());
    });
    this.pc.addEventListener("connectionstatechange", () => {
      cbs.onStateChange?.(this.pc.connectionState);
    });
    this.pc.addEventListener("datachannel", (e) => {
      this.attachDC(e.channel);
    });
  }

  private attachDC(dc: RTCDataChannel) {
    dc.binaryType = "arraybuffer";
    const label = dc.label;
    dc.onopen = () => {
      this.cbs.onDataChannelOpen?.(label);
    };
    dc.onclose = () => {
      this.cbs.onDataChannelClose?.(label);
    };
    dc.onmessage = (e) => {
      if (label === "pty") {
        if (typeof e.data === "string") {
          this.cbs.onPtyString?.(e.data);
        } else {
          this.cbs.onPtyBytes?.(e.data as ArrayBuffer);
        }
      } else if (label === "sidechannel") {
        try {
          const obj = typeof e.data === "string"
            ? JSON.parse(e.data)
            : JSON.parse(new TextDecoder().decode(e.data as ArrayBuffer));
          this.cbs.onSidechannelEvent?.(obj);
        } catch {
          /* ignore malformed */
        }
      }
    };
    if (label === "pty") this.pty = dc;
    else if (label === "sidechannel") this.side = dc;
  }

  async acceptOffer(sdp: string): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  async addIce(c: RTCIceCandidateInit) {
    if (!c || !c.candidate) return;
    try {
      await this.pc.addIceCandidate(c);
    } catch {
      /* non-fatal */
    }
  }

  // Phone -> Mac: send user keystrokes (text).
  sendInput(data: string) {
    if (!this.pty || this.pty.readyState !== "open") return;
    this.pty.send(JSON.stringify({ type: "input", data }));
  }

  // Phone -> Mac: report new terminal dimensions after a resize.
  sendResize(cols: number, rows: number) {
    if (!this.pty || this.pty.readyState !== "open") return;
    this.pty.send(JSON.stringify({ type: "resize", cols, rows }));
  }

  close() {
    try { this.pty?.close(); } catch {}
    try { this.side?.close(); } catch {}
    try { this.pc.close(); } catch {}
  }
}
