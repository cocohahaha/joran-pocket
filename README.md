# JORAN Pocket

**Drive your Mac's terminal from your iPhone, from anywhere.**

Public HTTPS URL → password-protected web terminal → persistent `tmux` session on your Mac. Works through GFW, cellular, any Wi‑Fi. Zero cloud accounts to sign up for.

```
iPhone Safari                                    your Mac
   │                                                │
   │  HTTPS (basic auth)                            │
   │  https://xxx.trycloudflare.com                 │
   │                                                │
   ▼                                                ▼
cloudflared Quick Tunnel ──▶ ttyd :8080 ──▶ tmux session 'pocket' ──▶ zsh / claude / whatever
```

---

## Prerequisites

- macOS (Apple Silicon or Intel)
- [Homebrew](https://brew.sh) installed
- A terminal with 30 seconds to spare

Dependencies (`tmux`, `ttyd`, `cloudflared`) are installed automatically by the installer if missing.

---

## Install

```bash
git clone https://github.com/<your-github>/joran-pocket.git
cd joran-pocket
bash install.sh
```

The installer will:
1. Check/install `tmux`, `ttyd`, `cloudflared` via Homebrew
2. Prompt for a login username + password (saved to `~/Pocket/auth.txt`, mode 600)
3. Install three launchd services (auto-start at login, auto-restart on crash)
4. Install `~/.tmux.conf` (mobile-friendly — backs up any existing one)
5. Install the `pocket` CLI into `/opt/homebrew/bin` (or `/usr/local/bin`)
6. Wait for the Cloudflare Quick Tunnel to produce a URL, then print it

Run time: ~30 seconds (excluding `brew install` if deps missing).

---

## Daily use

**Get the current URL (and copy it to your clipboard):**
```bash
pocket
```

**Other commands:**
```bash
pocket status       # service state + URL
pocket restart      # rotate the URL
pocket stop         # halt services
pocket attach       # attach your current Mac terminal to the shared tmux session
pocket logs         # tail the tunnel log
pocket help         # full list
```

**On your iPhone:**
1. Open the URL in Safari
2. Enter the username + password you set at install
3. Tap *Share → Add to Home Screen* — you now have a fullscreen PWA icon
4. Tap the terminal, use the iOS system keyboard (or the on-screen ↑↓←→ ESC TAB ⏎ bar at the bottom of the tmux status line) to drive your Mac

Because it's a real `tmux` session, your work persists across phone closes, Mac reboots, URL rotations, and screen lid closes. Attach later on your Mac with `pocket attach` and pick up where you left off.

---

## Optional: iMessage URL updates

Cloudflare Quick Tunnel URLs rotate each time the tunnel restarts. To get the new URL pushed to your phone automatically:

```bash
echo 'your-email@example.com' > ~/Pocket/imessage-to.txt
pocket restart
```

Any email/phone registered with iMessage works. Requires `Messages.app` to be signed in on this Mac.

Leave that file empty/missing to skip iMessage entirely.

---

## Optional: Claude Code skill

If you use [Claude Code](https://docs.claude.com/en/docs/claude-code/overview), the installer drops a skill into `~/.claude/skills/pocket/` so you can say things like "启动口袋" / "open pocket" / "give me the tunnel URL" and Claude will run the full workflow (fetch URL + spawn a new attached Terminal window).

---

## How it works

| Component | What it does |
|---|---|
| `tmux` session `pocket` | persistent shell on your Mac; survives everything |
| `ttyd` (on 127.0.0.1:8080) | serves the tmux session as a web terminal with HTTP Basic Auth |
| `cloudflared tunnel --url` | exposes that local port to a public `*.trycloudflare.com` URL (no Cloudflare account required) |
| watcher script | tails tunnel logs, writes new URL to `~/Pocket/current-url.txt`, optionally iMessages it |
| launchd agents | keep all three alive across login/crash |
| `~/.tmux.conf` | dark theme, Ctrl-A prefix, mouse mode, two-line status bar with tappable phone keys |

---

## Security model

- **HTTP Basic Auth** in front of `ttyd` — credentials saved to `~/Pocket/auth.txt` (mode 600)
- **HTTPS in transit** — Cloudflare terminates TLS; traffic between the tunnel edge and your Mac is over the Cloudflared connection
- **Unguessable URL** — `https://<random-words>.trycloudflare.com`
- **Local-only ttyd** — binds to `127.0.0.1`, never exposed directly
- **No cloud account** — the Quick Tunnel is anonymous; nothing to compromise if this computer is compromised other than... this computer

**Known limitations:**
- Basic auth only; no rate limiting beyond ttyd's `--max-clients`
- URL is public — rely on the password for defense in depth
- No audit logging of failed auth attempts

Do not use this to expose production systems, shared machines, or anything you wouldn't hand to a stranger if they had the URL + password.

---

## Uninstall

```bash
# Stop services
launchctl bootout gui/$UID/pocket.tmux.watcher
launchctl bootout gui/$UID/pocket.tmux.tunnel
launchctl bootout gui/$UID/pocket.tmux.ttyd

# Remove plists
rm ~/Library/LaunchAgents/pocket.tmux.*.plist

# Remove data
rm -rf ~/Pocket

# Remove CLI
rm -f /opt/homebrew/bin/pocket /usr/local/bin/pocket

# (optional) restore old tmux config from backup
ls ~/.tmux.conf.bak.*    # pick the latest, then:
# mv ~/.tmux.conf.bak.YYYYMMDD-HHMMSS ~/.tmux.conf
```

---

## License

MIT — see [LICENSE](LICENSE).

---

## 中文简介

**用 iPhone 操纵家里 Mac 的终端——无需公网 IP、无需 VPS、无需任何云账号。**

Cloudflare 的免费 Quick Tunnel 把你本地的 ttyd 暴露成一个随机 HTTPS URL；你的 iPhone 在任何网络（含 GFW 内）访问那个 URL 就能登录家里电脑的 `tmux` 会话，跑 `claude`、`vim`、`ssh`、任何你想跑的东西。会话常驻，手机关了、电脑重启、隧道换 URL，会话都还在。

**三步装：**
```bash
git clone https://github.com/<your-github>/joran-pocket.git
cd joran-pocket
bash install.sh       # 会让你设一次密码
```
完事。iPhone Safari 打开打印出来的 URL，输密码，`Share → Add to Home Screen` 钉到桌面，下次点图标全屏进终端。

**日常就一个命令：** `pocket` — 打印当前 URL + 塞进剪贴板。URL 变了 iMessage 还能自动推送（可选）。

密码存在 `~/Pocket/auth.txt`（权限 600），谁都拦不住——除了你自己。
