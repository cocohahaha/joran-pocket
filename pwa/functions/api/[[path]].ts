// Pages Functions catch-all for /api/*
// Handles: /api/health, /api/register, /api/pair/:code/ws
// The Durable Object class PairingSession lives in the sibling Worker
// project (signaling/). We access it here via env.SESSION which is wired
// via pwa/wrangler.toml -> script_name = "joran-pocket-signaling".

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const MAX_UNPAIRED_MS = 5 * 60_000;
const MAX_MSG_BYTES = 64 * 1024;

interface Env {
  SESSION: DurableObjectNamespace;
}

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  if (path === "/api/health") {
    return withCors(new Response(JSON.stringify({ ok: true }), json()));
  }

  if (request.method === "POST" && path === "/api/register") {
    const code = makeCode();
    const id = env.SESSION.idFromName(code);
    const stub = env.SESSION.get(id);
    await stub.fetch(new Request("https://do/init", { method: "POST" }));
    return withCors(new Response(JSON.stringify({
      code,
      wss: `wss://${url.host}/api/pair/${code}/ws`,
      expires_in_s: Math.floor(MAX_UNPAIRED_MS / 1000),
    }), json()));
  }

  const m = path.match(/^\/api\/pair\/([A-Z0-9]+)\/ws$/);
  if (m) {
    const code = m[1];
    const id = env.SESSION.idFromName(code);
    const stub = env.SESSION.get(id);
    return stub.fetch(request);
  }

  return withCors(new Response("joran-pocket signaling — unknown /api path", { status: 404 }));
};

function makeCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let s = "";
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s;
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}
function json(): ResponseInit { return { headers: { "content-type": "application/json", ...corsHeaders() } }; }
function withCors(r: Response): Response {
  const h = new Headers(r.headers);
  for (const [k, v] of Object.entries(corsHeaders())) h.set(k, v);
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

// PairingSession Durable Object class lives in signaling/src/index.ts (the
// sibling Worker project). Update via: cd signaling && wrangler deploy.
