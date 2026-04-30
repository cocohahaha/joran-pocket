# JORAN Pocket

**手机 Safari 直连你 Mac 的终端 / Claude Code — WebRTC P2P，零账号、零订阅、零 VPN 冲突。**

> 🔐 **每个用户在自己 Cloudflare 账号下部署**。setup.sh 用你账号的免费配额,作者看不到你的会话,你的免费额度只服务你一人。

```
iPhone Safari                  (公网)                     你的 Mac
   │                                                          │
   │  ① 短信令握手 (~10 个 JSON 消息)                          │
   │  ── Cloudflare Pages Functions + Durable Object ────────┤
   │                                                          │
   │  ② WebRTC DataChannel,DTLS 加密,NAT 打洞 P2P             │
   │  ══════════════════════════════════════════════════════════
   │     终端字节 · 键入 · sidechannel (pane_size, windows...)
   │                                                          │
   ▼                                                          ▼
 PWA UI (xterm + compose bar + approval sheet)    tmux 'pocket' → claude
```

**终端字节从不经过任何服务器** — 只有 SDP/ICE 通过 Cloudflare 免费额度的信令中转。
不用 Cloudflare Tunnel、不用 ngrok、不用 Tailscale、不用端口转发、终端用户不用买域名。

---

## 一键部署 (推荐)

在 Mac Terminal 里粘贴：

```bash
curl -fsSL https://raw.githubusercontent.com/cocohahaha/joran-pocket/main/scripts/setup.sh | bash
```

脚本会引导你：

1. 检查 / 装齐依赖 (Homebrew、Go、Node、tmux、jq)
2. `wrangler login` 进你自己的 Cloudflare 账号
3. 部署你自己的信令 Worker (free tier，无信用卡)
4. 部署 PWA 到 Cloudflare Pages
5. 编译 helper 二进制并装到 PATH
6. 让你输入 iMessage 接收方 (邮箱 / 手机号),发一条测试消息验证
7. 装 LaunchAgent 让 helper 开机自启 (默认 IDLE,无链接)
8. 跑端到端连通性测试

完成后,**任何 Terminal 窗口里**:

```bash
pocket attach     # 激活 helper + 注册新链接 + iMessage 推到 iPhone
pocket sleep      # 立即吊销链接 (Mac 恢复正常熄屏)
pocket status     # 查状态
```

---

## 为什么不用现成方案

| 现成方案 | 失败原因 |
|---|---|
| ttyd + Cloudflare Quick Tunnel | Cloudflare 边缘在 `--protocol http2` 上掉 WebSocket;QUIC 在很多网络被阻 |
| ttyd + localhost.run | 中继节点在真实使用下会超时 / 断 |
| Tailscale + SSH | iOS 只有一个 VPN 槽位 — 跟 Astrill / 公司 VPN 冲突 |
| Anthropic 官方 Remote Control | 走 Anthropic cloud,蜂窝网下还想再开 VPN |

JORAN Pocket 全部规避:信令短期 + 仅元数据;热数据 P2P;不占 VPN 槽。

---

## 仓库结构

```
joran-pocket/
├── signaling/        Cloudflare Worker — SDP/ICE broker (TypeScript)
│   └── src/index.ts    PairingSession Durable Object
├── helper/           Mac CLI — tmux + PTY + pion/webrtc peer (Go)
│   ├── main.go         IDLE / ACTIVE 状态机
│   ├── active.go       ~/.pocket/active 标记
│   ├── pair.go         WebRTC peer + DataChannels
│   ├── tmux.go         tmux 隔离 socket + 配置
│   ├── pane_size.go    尺寸同步 (200ms 采样 + refresh-client)
│   ├── windows.go      tmux 窗口列表 watcher
│   ├── state.go        Claude Code 状态识别
│   ├── caffeinate.go   防熄屏 / 屏保
│   ├── launchd.go      LaunchAgent 安装
│   └── imessage.go     osascript Messages.app 推送
├── pwa/              Phone PWA — React + Vite + xterm.js
│   ├── src/App.tsx
│   ├── src/components/Terminal.tsx
│   ├── functions/api/[[path]].ts   Pages Functions catch-all
│   └── public/
│       ├── about.html      产品说明 + 完整架构图
│       ├── setup.sh        一键部署引导脚本
│       └── install.sh      仅装 helper (假设信令已部署)
├── landing/          产品首页 (与 pwa/public/about.html 同源)
├── scripts/
│   ├── setup.sh        本文档主要推荐入口
│   └── install.sh      仅装 helper
├── ARCHITECTURE.md   完整技术架构文档
├── README.md         本文件
└── LICENSE           MIT
```

---

## 三种安装路径

### A. 一键引导 (新机器,推荐)
适合:第一次跑这个项目的人,自己有 Cloudflare 账号。

```bash
curl -fsSL https://raw.githubusercontent.com/cocohahaha/joran-pocket/main/scripts/setup.sh | bash
```

### B. 复用别人部署的 Worker (轻量)
适合:朋友已经部署过 Worker + Pages,你只想装 helper。

```bash
curl -fsSL https://raw.githubusercontent.com/cocohahaha/joran-pocket/main/scripts/install.sh | bash
# 提示输入 POCKET_SIGNALING URL,粘贴对方部署的 *.pages.dev 地址
```

### C. 从源码 (开发者)
适合:贡献代码 / 改造。

```bash
git clone https://github.com/cocohahaha/joran-pocket
cd joran-pocket
bash scripts/setup.sh         # 同 A,但跑本地脚本
```

---

## 用法 (装好之后)

```bash
pocket attach          # 激活 helper、推 iMessage、当前 Terminal 接管 tmux
pocket sleep           # 吊销链接、helper 转 IDLE、Mac 恢复熄屏
pocket url             # 看当前 URL
pocket status          # 看 LaunchAgent / helper / IDLE|ACTIVE / URL
pocket install         # 装 LaunchAgent (开机自启)
pocket uninstall       # 卸 LaunchAgent
```

每次 `pocket attach`:

1. 触摸 `~/.pocket/active` → helper 250ms 内检测到 → 转 ACTIVE
2. helper 注册新 6 位码 → 写 url.txt → iMessage 推到 iPhone
3. 启动 caffeinate → Mac 屏幕在 attach 期间不熄
4. 当前 Terminal 自动 `tmux attach-session`

每次 `pocket sleep`:

1. 删 `~/.pocket/active`
2. helper 2s 内检测到 → 关 PeerConnection、停 caffeinate、删 url.txt
3. 链接立即失效,Mac 恢复正常熄屏

---

## 安全模型

- **端到端加密**:WebRTC DataChannel 用 DTLS;信令 Worker 看不到任何终端内容
- **On-demand 链接**:默认 IDLE 没有链接;只有显式 `pocket attach` 才生效
- **窗口短**:`pocket sleep` 立即吊销,链接失效时间在你掌控
- **6 位码**:32 位字母表,~10亿组合,过期窗口短;暴力穷举不实际
- **信令服务器看到的**:SDP offer/answer (含你的公网 IP — 这是 WebRTC 标配)、ICE candidates、6 位码。**不**包含任何字节
- **Helper 不会**:开 SSH、改你 shell config、跑你 tmux session 之外的东西

---

## 完整文档

- [ARCHITECTURE.md](./ARCHITECTURE.md) — 完整技术架构 / 组件 / 决策原因
- [pwa/public/about.html](./pwa/public/about.html) — 产品说明页 (= [joran-pocket.pages.dev/about.html](https://joran-pocket.pages.dev/about.html))

---

## 许可

MIT。见 [LICENSE](./LICENSE)。

---

## English (TL;DR)

In Mac terminal: `pocket attach` — helper activates, iMessages link to your iPhone,
takes over your Terminal with tmux. In Safari, open the link — direct WebRTC P2P
to your terminal. `pocket sleep` to revoke. Operator deploys signaling Worker to
their own free-tier Cloudflare account once via `setup.sh`; end users zero-account.
