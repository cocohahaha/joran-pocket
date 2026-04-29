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
const MAX_UNPAIRED_MS = 60 * 60_000; // 1 hour — generous window so users don't race the clock
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
    const other: Role = role === "host" ? "guest" : "host";
    // Tell the OTHER peer that someone joined. If the OTHER peer was already
    // here when this new one connected, the new one also needs to be told —
    // otherwise whoever connects second never learns their counterpart exists.
    if (this.peers.has(other)) {
      this.send(other, { type: "peer-joined", role });
      this.send(role, { type: "peer-joined", role: other });
    }

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
      const other2: Role = role === "host" ? "guest" : "host";
      this.send(other2, { type: "peer-left", role });
      // Do NOT shutdown immediately on 0 peers. Host & guest may reconnect
      // with the same pairing code (auto-reconnect on transient failures).
      // The alarm will clean up after MAX_UNPAIRED_MS of no activity.
    });
    server.addEventListener("error", () => {
      this.peers.delete(role);
    });

    // Reset the auto-shutdown alarm: check once a minute while waiting for
    // the other peer; once per 60s while paired.
    const next = this.peers.size < 2 ? 60_000 : 60_000;
    await this.state.storage.setAlarm(Date.now() + next);

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
    const IDLE_THRESHOLD_MS = 10 * 60_000; // 10 min silence = dead

    // If nobody's connected at all and the session is more than a minute
    // old, garbage-collect. (One-minute grace period lets host reconnect
    // after transient WebSocket drops.)
    if (this.peers.size === 0) {
      if (now - this.createdAt > 60_000) { this.shutdown(); return; }
    } else {
      // Peers are connected: only kill if EVERY peer has been silent past
      // IDLE_THRESHOLD_MS. With helper pinging every 25s, this never fires
      // while the Mac-side process is alive — so the pairing URL stays
      // valid for the entire lifetime of the helper.
      const everyoneQuiet = [...this.peers.values()].every(p => now - p.lastSeen > IDLE_THRESHOLD_MS);
      if (everyoneQuiet) { this.shutdown(); return; }
    }
    // Reschedule for next check.
    await this.state.storage.setAlarm(now + 60_000);
  }

  private shutdown() {
    for (const p of this.peers.values()) {
      try { p.ws.close(1000, "session ended"); } catch {}
    }
    this.peers.clear();
    this.state.storage.deleteAll().catch(() => {});
  }
}
