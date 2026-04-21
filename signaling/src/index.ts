// JORAN Pocket — WebRTC Signaling Worker
//
// Brokers SDP offers/answers and ICE candidates between a Mac helper (peer A,
// "host") and a phone PWA (peer B, "guest"). Traffic is small, short-lived,
// JSON-over-WebSocket; terminal data never passes through this Worker — it
// flows over WebRTC DataChannel peer-to-peer after the handshake.
//
// Protocol:
//   POST /register           host creates a pairing session; returns { code, wss }
//   GET  /pair/<code>/ws     host + guest both connect here (WebSocket upgrade)
//
// Session lifecycle:
//   - host registers → gets 6-char code, DO created
//   - host opens its WS slot ("host")
//   - guest opens its WS slot ("guest")
//   - Worker relays offer → answer → ICE candidates verbatim
//   - either peer sends {"type":"done"} or disconnects → DO cleans up after 60s idle
//   - unpaired codes expire after 5 min

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // excludes I,O,0,1 for readability
const CODE_LENGTH = 6;
const MAX_IDLE_MS = 60_000;
const MAX_UNPAIRED_MS = 5 * 60_000;
const MAX_MSG_BYTES = 64 * 1024; // refuse anything weirdly large

interface Env {
  SESSION: DurableObjectNamespace;
}

// ---------- Top-level Worker ----------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // CORS for browser PWA (hosted on a different origin than the Worker)
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (req.method === "POST" && url.pathname === "/register") {
      return withCors(await handleRegister(req, env));
    }

    const pairMatch = url.pathname.match(/^\/pair\/([A-Z0-9]+)\/ws$/);
    if (pairMatch) {
      const code = pairMatch[1];
      const id = env.SESSION.idFromName(code);
      const stub = env.SESSION.get(id);
      return stub.fetch(req);
    }

    if (url.pathname === "/health") {
      return withCors(new Response(JSON.stringify({ ok: true }), json()));
    }

    return withCors(new Response("joran-pocket signaling\n\ntry POST /register", { status: 404 }));
  },
} satisfies ExportedHandler<Env>;

async function handleRegister(req: Request, env: Env): Promise<Response> {
  const code = makeCode();
  const id = env.SESSION.idFromName(code);
  const stub = env.SESSION.get(id);
  // Touch the DO so it can schedule its expiry alarm.
  await stub.fetch(new Request(`https://do/init?code=${code}`, { method: "POST" }));

  const host = req.headers.get("host") ?? "";
  const origin = `wss://${host}`;
  return new Response(JSON.stringify({
    code,
    wss: `${origin}/pair/${code}/ws`,
    expires_in_s: Math.floor(MAX_UNPAIRED_MS / 1000),
  }), json());
}

function makeCode(): string {
  const out = new Array<string>(CODE_LENGTH);
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  for (let i = 0; i < CODE_LENGTH; i++) {
    out[i] = CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out.join("");
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };
}

function json(): ResponseInit {
  return { headers: { "content-type": "application/json", ...corsHeaders() } };
}

function withCors(r: Response): Response {
  const h = new Headers(r.headers);
  for (const [k, v] of Object.entries(corsHeaders())) h.set(k, v);
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

// ---------- Durable Object: PairingSession ----------

type Role = "host" | "guest";

interface Peer {
  ws: WebSocket;
  role: Role;
  lastSeen: number;
}

export class PairingSession {
  private state: DurableObjectState;
  private peers: Map<Role, Peer> = new Map();
  private code: string | null = null;
  private createdAt: number = 0;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/init") {
      this.code = url.searchParams.get("code");
      this.createdAt = Date.now();
      await this.state.storage.setAlarm(Date.now() + MAX_UNPAIRED_MS);
      return new Response("ok");
    }

    const upgradeHeader = req.headers.get("upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("expected websocket upgrade", { status: 400 });
    }

    // Role is supplied explicitly via ?role=host|guest so both sides are
    // deterministic regardless of which connects first. If omitted, assume
    // host first (backwards-compat for early CLI builds).
    const requested = url.searchParams.get("role");
    const role: Role = requested === "guest" ? "guest" : "host";
    if (this.peers.has(role)) {
      return new Response(`role '${role}' already taken`, { status: 409 });
    }

    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    const peer: Peer = { ws: server, role, lastSeen: Date.now() };
    this.peers.set(role, peer);

    // Tell the new arrival who they are.
    this.send(role, { type: "hello", role });
    // Tell the OTHER peer (if any) that a new one joined — don't echo back.
    const other: Role = role === "host" ? "guest" : "host";
    this.send(other, { type: "peer-joined", role });

    server.addEventListener("message", (evt) => {
      peer.lastSeen = Date.now();
      const raw = evt.data;
      if (typeof raw !== "string") return; // ignore binary
      if (raw.length > MAX_MSG_BYTES) return;

      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw); } catch { return; }

      // Accept offer / answer / ice / done; relay to the other peer verbatim.
      const t = msg.type;
      if (t !== "offer" && t !== "answer" && t !== "ice" && t !== "done" && t !== "ping") return;

      if (t === "ping") {
        try { server.send(JSON.stringify({ type: "pong" })); } catch {}
        return;
      }

      const target: Role = role === "host" ? "guest" : "host";
      this.send(target, msg);

      if (t === "done") {
        // Both peers signal ready; close everything soon.
        setTimeout(() => this.shutdown(), 5_000);
      }
    });

    server.addEventListener("close", () => {
      this.peers.delete(role);
      const other: Role = role === "host" ? "guest" : "host";
      this.send(other, { type: "peer-left", role });
      if (this.peers.size === 0) this.shutdown();
    });
    server.addEventListener("error", () => {
      this.peers.delete(role);
    });

    // Reset the auto-shutdown alarm on activity.
    await this.state.storage.setAlarm(Date.now() + MAX_IDLE_MS);

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private send(target: Role, obj: unknown) {
    const peer = this.peers.get(target);
    if (!peer) return;
    try { peer.ws.send(JSON.stringify(obj)); } catch { /* peer gone */ }
  }

  private notify(obj: unknown) {
    for (const p of this.peers.values()) {
      try { p.ws.send(JSON.stringify(obj)); } catch {}
    }
  }

  async alarm() {
    const now = Date.now();
    const idle = this.peers.size === 0 ? MAX_IDLE_MS : 30_000;
    // Force-close anyone hanging around forever.
    const expired = now - this.createdAt > MAX_UNPAIRED_MS && this.peers.size < 2;
    const quiet = [...this.peers.values()].every(p => now - p.lastSeen > idle);

    if (expired || quiet || this.peers.size === 0) {
      this.shutdown();
    } else {
      await this.state.storage.setAlarm(Date.now() + MAX_IDLE_MS);
    }
  }

  private shutdown() {
    for (const p of this.peers.values()) {
      try { p.ws.close(1000, "session ended"); } catch {}
    }
    this.peers.clear();
    this.state.storage.deleteAll().catch(() => {});
  }
}
