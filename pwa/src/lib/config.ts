// Runtime configuration for the PWA.
// The PWA and signaling API share the same origin (Pages Functions under
// /api/*), so by default we use window.location.origin — zero config.
// An override is still supported via VITE_SIGNALING_HOST or ?signaling= for
// dev / alternate backends.

const BUILD_TIME_SIGNALING = import.meta.env.VITE_SIGNALING_HOST ?? "";

export function getSignalingHost(): string {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("signaling");
  const base = (fromQuery || BUILD_TIME_SIGNALING || window.location.origin).replace(/\/+$/, "");
  return base;
}

export function buildPairWssURL(signalingBase: string, code: string): string {
  const u = new URL(signalingBase);
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  u.pathname = `/api/pair/${code}/ws`;
  u.searchParams.set("role", "guest");
  return u.toString();
}

// Path where the PWA POSTs to mint a code (usually not used — the PWA is
// the guest side; the code comes from the Mac helper).
export function buildRegisterURL(signalingBase: string): string {
  return signalingBase.replace(/\/+$/, "") + "/api/register";
}

// The pairing URL format printed by the Mac helper: /p/CODE
// (Either opened directly from the QR code or pasted in.)
export function parseCodeFromLocation(): string | null {
  const path = window.location.pathname;
  const m = path.match(/^\/p\/([A-Z0-9]{4,8})\/?$/i);
  if (m) return m[1].toUpperCase();
  const params = new URLSearchParams(window.location.search);
  return params.get("code")?.toUpperCase() ?? null;
}
