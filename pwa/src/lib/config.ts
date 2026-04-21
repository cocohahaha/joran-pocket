// Runtime configuration for the PWA.
// In production the signaling host is baked at build time via VITE_SIGNALING_HOST.
// In dev you can override with a URL query parameter: ?signaling=https://...

const BUILD_TIME_SIGNALING = import.meta.env.VITE_SIGNALING_HOST ?? "";

export function getSignalingHost(): string {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("signaling");
  const base = (fromQuery || BUILD_TIME_SIGNALING || "").replace(/\/+$/, "");
  if (!base) {
    throw new Error(
      "no signaling host configured — set VITE_SIGNALING_HOST at build time, " +
      "or pass ?signaling=https://... in the URL during dev.",
    );
  }
  return base;
}

export function buildPairWssURL(signalingBase: string, code: string): string {
  const u = new URL(signalingBase);
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  u.pathname = `/pair/${code}/ws`;
  u.searchParams.set("role", "guest");
  return u.toString();
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
