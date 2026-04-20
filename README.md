# JORAN Pocket

**Drive your Mac's Claude Code from your iPhone — anywhere, any network.**

Works where Anthropic's official Remote Control doesn't (GFW, flaky cellular, captive Wi-Fi), because your phone talks **directly to your own Mac** over a private WireGuard mesh. No public URL, no VPN, no third-party cloud on the hot path.

---

## 🚀 推荐路线：Tailscale + SSH（5 分钟，最稳）

```
iPhone (Termius / Blink)            your Mac
   │                                    │
   │   SSH over Tailscale (WireGuard)   │
   │   100% 私网，加密，NAT 穿透        │
   │                                    │
   └───────────────▶  sshd → tmux 'pocket' → claude
```

### 为什么选这条路

- **真正丝滑**：Tailscale 是 WireGuard 现代封装，P2P 直连手机 ↔ Mac，基本不走中继
- **无需公网 IP / 域名 / 端口转发**：Tailscale 自动处理 NAT 穿透
- **无需 Anthropic 云**：Anthropic Remote Control 在非家用网络下要叠 VPN 才勉强能用；Tailscale 本身就是 VPN，一条路吃到底
- **无 WebSocket 兼容性问题**：原生 SSH 走 TCP 22，不依赖任何代理能否正确处理 WS
- **会话永续**：tmux 会话在 Mac 常驻，手机断网 / 换网 / 重启，重连回来 Claude 上下文不丢

### 安装（Mac 一次性，3 分钟）

```bash
git clone https://github.com/cocohahaha/joran-pocket.git
cd joran-pocket
bash install-tailscale.sh
```

脚本会：
1. 装 Tailscale（brew cask），引导你登录（Google/GitHub/Apple SSO，免费）
2. 开启 Mac 系统自带的 SSH 远程登录（需要你输一次 Mac 密码）
3. 装 tmux + 在 `~/.zshrc` 追加一行：SSH 进来自动 `tmux attach -s pocket`
4. 打印你 iPhone 要输的主机名 + 用户名

### iPhone 侧（一次性，2 分钟）

1. App Store 搜 **Tailscale** → 装 → 用**和 Mac 一样的账号**登录 → 开 VPN 总开关
2. App Store 搜 **Termius**（免费版够用）或 **Blink Shell**（$20/yr，带 Mosh，推荐发烧友）
3. Termius 里 New Host：
   - Hostname：脚本打印的 Tailscale 名字（形如 `your-mac.tail12345.ts.net`）
   - Username：你 Mac 的用户名
   - Password：Mac 登录密码（或配 SSH key 更佳）
4. 点一下连接 → 自动进 `pocket` tmux 会话 → 直接 `claude`

### 日常使用

| 场景 | 动作 |
|---|---|
| 出门 / 换 Wi-Fi / 蜂窝 | 不用管，Tailscale 会跟着走 |
| 开 Termius | 点之前保存的 Host，一秒进终端 |
| 会话不想丢 | 啥也别做，tmux 自然保留 |
| 断开不退出会话 | `Ctrl-b d`（detach） |
| 手动切 Claude / opencode / codex | 会话里直接敲即可 |

---

## 🕸️ 备选路线：浏览器 + 公网 Tunnel（不推荐）

下面 `install.sh` 是原先的 ttyd + Cloudflare/localhost.run 方案。**已知问题**：WebSocket 在部分网络下被公网中继吞掉（Cloudflare Quick Tunnel http2 边缘 404、localhost.run 间歇超时），iOS PWA 装到桌面后 Safari 语音输入静默失效。保留给有"必须用浏览器 / 不能装 App"特殊需求的场景。

<details>
<summary>展开：旧的 ttyd + tunnel 路线</summary>

```bash
bash install.sh          # 装 ttyd + cloudflared + 配密码
pocket                   # 拿公网 URL，复制到剪贴板
pocket restart           # URL 失效时换一个
pocket stop              # 关掉公网入口
```

详见 `install.sh` 和 `scripts/setup-services.sh`。

</details>

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
| `ssh -R` to `localhost.run` | exposes that local port to a public `*.lhr.life` HTTPS URL (no account, anonymous tunnel). WebSocket passes through cleanly, which cloudflared Quick Tunnel does NOT do on QUIC-blocked networks. |
| watcher script | tails tunnel logs, writes new URL to `~/Pocket/current-url.txt`, optionally iMessages it |
| launchd agents | keep all three alive across login/crash |
| `~/.tmux.conf` | dark theme, Ctrl-A prefix, mouse mode, two-line status bar with tappable phone keys |

---

## Security model

- **HTTP Basic Auth** in front of `ttyd` — credentials saved to `~/Pocket/auth.txt` (mode 600)
- **HTTPS in transit** — Cloudflare terminates TLS; traffic between the tunnel edge and your Mac is over the Cloudflared connection
- **Unguessable URL** — `https://<random-hex>.lhr.life`
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
