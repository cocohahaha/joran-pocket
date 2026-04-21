# JORAN Pocket

**Drive your Mac's Claude Code from your iPhone browser — WebRTC P2P, zero accounts, zero VPN conflicts.**

```
iPhone Safari                   (public internet)                   your Mac
   │                                                                   │
   │  ①② short pairing code + SDP/ICE exchange                          │
   │  ─────── Cloudflare Worker (signaling only; ~10 small JSON msgs) ──┤
   │                                                                   │
   │  ③ WebRTC DataChannel, DTLS-encrypted, NAT-punched P2P              │
   │  ═══════════════════════════════════════════════════════════════════┤
   │     terminal bytes • keystrokes • sidechannel (Claude state events) │
   │                                                                   │
   ▼                                                                   ▼
 PWA UI (xterm + compose bar + approval sheet)         tmux session 'pocket' → claude
```

**Terminal bytes never touch any server** — only SDP/ICE pass through the free-tier
signaling Worker, then the two peers talk directly. No Cloudflare tunnel, no ngrok,
no Tailscale, no port forward, no domain required for end users.

---

## Why this (and not something else)

| Previous attempt | Why it failed |
|---|---|
| ttyd + Cloudflare Quick Tunnel | Cloudflare edge drops WebSocket upgrades on `--protocol http2`; QUIC blocked on many networks |
| ttyd + localhost.run | Tunnel relay times out / disconnects under real use |
| Tailscale + SSH | iOS only has one VPN slot — conflicts with Astrill / corporate VPN |
| Anthropic's own Remote Control | Official path routes via Anthropic cloud; on cellular/restricted networks it wants a VPN on too |

JORAN Pocket skips all of those: signaling is short-lived and metadata-only;
heat data is P2P; no second VPN competing for the iOS slot.

---

## Repo layout (monorepo)

```
signaling/   Cloudflare Worker — SDP/ICE broker (TypeScript)
helper/      Mac CLI — tmux + PTY + pion/webrtc peer (Go)
pwa/         Phone PWA — React + xterm.js + RTCPeerConnection
landing/     Product homepage (static HTML)
scripts/     install.sh for end users
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for details.

---

## Deploy (your own Cloudflare account — one-time)

You need a free Cloudflare account (no credit card). End users don't — only the operator does.

```bash
# 1. Signaling Worker (runs under your free-tier Cloudflare account)
cd signaling
npm install
npx wrangler login           # opens browser OAuth
npx wrangler deploy
# note the deployed URL — looks like:
# https://joran-pocket-signaling.<your-cf-subdomain>.workers.dev
```

```bash
# 2. Phone PWA (static hosting on Cloudflare Pages, free)
cd ../pwa
npm install
VITE_SIGNALING_HOST="https://joran-pocket-signaling.<your-cf-subdomain>.workers.dev" npm run build
npx wrangler pages deploy dist --project-name joran-pocket
# Pages gives you a URL: https://joran-pocket.pages.dev
```

```bash
# 3. Mac helper (built locally from source for now; GitHub Releases will ship
#    prebuilt binaries later)
cd ../helper
go build -o ~/.pocket/bin/pocket .
ln -sf ~/.pocket/bin/pocket /opt/homebrew/bin/pocket
export POCKET_SIGNALING="https://joran-pocket-signaling.<your-cf-subdomain>.workers.dev"
export POCKET_PWA_URL="https://joran-pocket.pages.dev"
```

---

## End-user use (after operator has deployed the above)

**One-time** (on each user's Mac):

```bash
curl -fsSL https://joran-pocket.pages.dev/install.sh | bash
# Script prompts for the signaling URL (paste the operator-deployed one)
```

**Each time**:

```bash
pocket
```

Prints a 6-char pairing code (e.g., `EK7P2M`). On the phone, open
`https://joran-pocket.pages.dev/p/EK7P2M` in Safari. Code expires in 5 minutes.
After the first successful use, tap Share → Add to Home Screen.

---

## Security model

- **End-to-end encrypted**: WebRTC DataChannel uses DTLS; the signaling Worker
  never sees terminal content.
- **Pairing code**: 6 chars of a 32-char alphabet = ~1 billion combinations, 5-min
  window, one-shot. Brute force within the window is impractical.
- **Worker sees**: your SDP offer/answer (which includes your public IP — standard
  for WebRTC), ICE candidates, a 6-char code. Nothing else.
- **Helper does not**: open SSH, touch your shell config, or run anything beyond
  the tmux session you requested.

---

## License

MIT. See [LICENSE](./LICENSE).

---

## 中文

在 Mac 终端敲 `pocket` → 终端打出 6 位码和网址 → 手机 Safari 打开那个网址 →
WebRTC P2P 直连你家 Mac 的终端。无需任何账号、无需 VPN、不跟你现有 VPN
（比如 Astrill）冲突。

**操作者**需要一次性在自己 Cloudflare 免费账号下部署 Worker 和 Pages（各一条 wrangler 命令）。
**终端用户**零账号、零配置，下一个二进制 + 开浏览器 = 能用。
