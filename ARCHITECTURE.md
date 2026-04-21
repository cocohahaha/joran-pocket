# JORAN Pocket — WebRTC P2P Architecture

**设计目标**：任何一个 Claude Code 用户，在自己 Mac 上跑一个二进制 + 手机浏览器打开我们的网址扫个码，就能看自己的终端、驱动自己的 Claude——**零账号、零订阅、零信用卡**。

---

## 0. 三条铁律

1. **终端用户对外零账号**：不注册 Cloudflare、不装 Tailscale、不买域名、不配置路由器
2. **纯 P2P**：终端数据不经过我们（或任何第三方）的服务器
3. **我们是自己写**：不 fork 现成产品，不依赖闭源 SaaS 做热数据路径

符合这三条还能活下来的唯一技术答案 = **WebRTC DataChannel**

---

## 1. 核心组件

```
┌──────────────────────────┐                       ┌──────────────────────────┐
│  Mac（用户家里）          │                       │  iPhone（用户手上）       │
│                          │                       │                          │
│  ┌──────────────────┐    │                       │    ┌──────────────────┐  │
│  │ pocket helper    │    │                       │    │ Safari PWA       │  │
│  │ ─ tmux pocket    │    │                       │    │ ─ xterm.js       │  │
│  │ ─ PTY 桥         │    │                       │    │ ─ Compose bar    │  │
│  │ ─ pion/webrtc    │    │                       │    │ ─ Approval sheet │  │
│  └────┬─────────────┘    │                       │    └────┬─────────────┘  │
│       │                  │                       │         │                 │
└───────┼──────────────────┘                       └─────────┼─────────────────┘
        │         ╭────────────────────────────────╮          │
        │         │  信令（Cloudflare Worker       │          │
        └─────────┤   + Durable Object，我们运维）  ├──────────┘
        ②        │  只交换 SDP/ICE，不承载热数据    │          ②
                  ╰──────────────┬─────────────────╯
                                 │ ①
                 ╭───────────────┴────────────╮
                 │ 用户扫 QR / 输 6 位码建立配对 │
                 ╰─────────────────────────────╯
                                 ③
   ╭─────────────────────────────────────────────────╮
   │  WebRTC DataChannel（P2P，NAT 打洞，DTLS 加密）   │  ← 热数据走这条
   │  Mac PTY bytes ↕ Phone keystrokes ↕ sidechannel  │
   ╰─────────────────────────────────────────────────╯
```

**数据分层**：
- ①②信令：小包、一次性、我们运维
- ③热数据：视频通话级别带宽、P2P、不过我们

---

## 2. 组件拆解

### 2.1 Mac helper（Go，单文件静态二进制，~8MB）

**为什么选 Go**：`pion/webrtc` 是业界最成熟的非浏览器 WebRTC 库（千万级下载、Twitch/Tailscale 都在用），`github.com/creack/pty` 做 PTY，`go.bug.st/tmux` 做 tmux 交互。交叉编译 macOS amd64/arm64 一命令搞定，二进制用户点一下就能跑。

**职责**：
1. 启一个 `tmux new-session -A -s pocket` — 如果不存在就创建
2. 把 tmux 的 client PTY fd 拿到
3. 连信令服务器，注册一个**6 位短码**（或 QR 编码的 URL）
4. 等手机 peer 发来 SDP offer
5. `pion/webrtc` 建 DataChannel
6. 打通 PTY ↔ DataChannel 的双向字节流
7. **协议桥 goroutine**：并行读 PTY 输出的副本，正则匹配 Claude Code 状态（等 y/n、执行 Bash、diff），通过**第二个 DataChannel**（`sidechannel`）推 JSON 事件给手机
8. 重启、心跳、断线重连

**安装**：`install.sh` curl 一行，或 `brew install joranpocket/tap/pocket`，或直接下 .pkg 双击

**配置文件**：无。零配置，默认行为合理。

### 2.2 信令服务器（Cloudflare Worker + Durable Object）

**为什么选 Cloudflare Worker**：
- 全球 300+ 个边缘节点（中国也有好几个 PoP）
- 免费额度每天 10 万请求（撑到用户破千也还免费）
- Durable Object 天然适合做"两个 peer 汇合"的会话保持
- WebSocket 原生支持
- 部署 = `wrangler deploy`，5 秒，zero server ops

**协议**：

```
POST /register              → 分配 6 位短码（或 UUID）; 返回 WSS URL
WSS /session/:code          → peer 加入这个 session
```

一个 Session 里消息格式（JSON over WebSocket）：
```json
{"type":"offer","sdp":"..."}
{"type":"answer","sdp":"..."}
{"type":"ice","candidate":{...}}
{"type":"ready"}                // 双方 DataChannel 建好后发这个，信令即可断开
```

**生命周期**：6 位码 60 秒内未完成配对 → 回收；DataChannel 建立后 → 关闭 WebSocket，Durable Object 10 秒无消息自销。

**成本预估**：
- 平均一个配对 ~10 条小 JSON 消息（2KB 总）
- 10 万次/天 免费额度 = 1 万次配对/天（远够）
- Durable Object 每秒 1GB-s 免费
- **MVP 期免费**

### 2.3 手机 PWA（React + xterm.js + 原生 RTCPeerConnection）

**为什么选 React + Vite**：前端已经习惯的栈，生态最大，构建产物就是静态 HTML/JS/CSS 可以丢任何 CDN。

**组件树**：
```
<App>
  <PairView>              ← 扫描 QR / 输入 6 位码 / 粘贴短 URL
  <TerminalView>          ← 配对成功后展示
    <Terminal xterm.js/>  ← 占屏幕 ~55%，只读渲染 PTY bytes
    <ApprovalSheet/>      ← Claude 等输入时浮起的大 Y/N 按钮（来自 sidechannel）
    <ComposeBar>          ← 底部大 textarea + 发送键；绕开 xterm.js 预测输入 bug
      <QuickKeys/>        ← ↑↓←→ ⎋ ⇥ ⏎ Ctrl y n
      <VoiceBtn/>         ← 调 iOS 键盘麦克风（Safari 原生 tab 里能用）
    </ComposeBar>
  </TerminalView>
</App>
```

**部署**：`vite build` → 丢到 **Cloudflare Pages**（免费、自动 HTTPS、自定义域名免费）或 **GitHub Pages**。用户访问 `https://pocket.joran.dev/`（或 `.pages.dev`）

### 2.4 协议桥（Mac helper 内嵌的 goroutine）

**状态检测**：扫 tmux 最新 40 行，匹配正则：

| 状态 | 触发 | 手机 UI 效果 |
|---|---|---|
| `awaiting-approval` | 最后行匹配 `Do you want to proceed\? \(y/n\)` 等 | 浮起 Allow/Deny 大按钮，震动 |
| `executing-bash` | 看到 `Running: ` + 某命令 | 顶栏显示"正在跑: `<cmd>`" |
| `diff-ready` | 看到 `❯` + 大段 diff | 显示 "查看改动" 按钮 |
| `idle` | 终端 >3s 无输出 | 清除状态 |

**传输**：单独一条 WebRTC DataChannel（label=`sidechannel`）用来推 JSON，不污染主字节流。

---

## 3. 配对 UX（关键用户流）

**第一次用**：
1. 用户在 Mac 跑 `pocket` → 终端里打印：
   ```
   配对码：EK7P2M
   或扫描：[ QR 图，内容是 https://pocket.joran.dev/p/EK7P2M ]
   60 秒内在手机上打开上面任一方式。
   ```
2. 用户 iPhone Safari 打开那个 URL（或扫 QR）
3. 浏览器立即连信令 WSS → 找到 Session → 交换 SDP
4. 10-30 秒后 WebRTC DataChannel 建好 → 终端出现，Compose bar 可用
5. 信令连接立即关闭，之后纯 P2P

**日常用**：手机 Safari **添加到主屏幕**（这步原生免费），下次点图标。**配对短码记在 localStorage**，Mac 重新启动后可自动复用（实际上每次都需要新鲜 SDP，但 6 位码如果用户"Pin"则会重新注册同一个短码）。

**同一个家的网络下**：WebRTC 的 ICE 优先选 mDNS/本地地址，**局域网延迟 <10ms**。

**外网**：走 STUN 打洞（Google 公共 STUN 免费），~95% 成功率。剩下 5% 打不了洞的需要 TURN 中继，**MVP 阶段先不加**，失败时提示用户"换个网络试试"。

---

## 4. 安全模型

**密钥**：
- WebRTC DataChannel 自带 DTLS，密钥在 SDP 握手时协商（不经过服务器可读层）
- 端到端加密由协议保证，**信令服务器（即 Cloudflare Worker）看不到终端内容**

**配对码的攻击面**：
- 6 位码空间 = 22^6 ≈ 1 亿（使用去除混淆字符的 base32）
- 60 秒窗口 + 一次性使用 + 每 IP 限速 → 暴力破解不可行
- 但万一有人猜中正在配对的 Session？他只能插入自己的 SDP → 真 peer 的 SDP 被覆盖 → 用户 Mac 端看到多次 offer 或不匹配 → 拒绝握手。

**谁能连我的 Mac**：只有完成 WebRTC 握手的 peer。攻击者需要在配对窗口内物理接管、或预知 6 位码。实践中比一个弱密码强得多。

**Mac helper 的权限**：只开 tmux pane，**不动 SSH、不碰系统、不碰用户其他文件**。读的只是 tmux pane 的内容。Claude Code 已经在 tmux 里跑，所以没有新增权限面。

---

## 5. 部署拓扑（成品网站）

```
joran.dev（landing page + 下载）
    │
    ├── GitHub Pages（我们账号部署的 React 静态站）
    │
pocket.joran.dev（PWA）
    │
    ├── Cloudflare Pages（同一个 git push → auto deploy）
    │
sig.joran.dev（信令）
    │
    └── Cloudflare Workers + Durable Object
```

**首次发布成本**：$0（全部走免费额度）
**月运行成本（MVP，<1000 活跃用户）**：$0
**规模化成本**（1 万 DAU 级别）：$5-10/月（Worker 超出免费额度）

---

## 6. 实现路线图（2-3 周 MVP）

**Week 1 — 骨架跑通**
- D1: 信令 Worker + wrangler 部署
- D2-3: Mac helper 最小版——PTY + pion/webrtc + 连信令 + DataChannel 打通
- D4-5: 手机 PWA 最小版——xterm.js 只读渲染 + 基础输入

**Week 2 — 产品化**
- D6-7: 配对 UX（QR、短码、pair view）
- D8-9: Compose bar + quick keys + Approval sheet
- D10: 协议桥（Claude 状态检测）

**Week 3 — 打磨 + 发布**
- D11-12: 安装器 (`install.sh` + brew tap)
- D13: Landing page
- D14: 真实 24 小时稳定性测试 + 两三个朋友试用
- D15: 发 Show HN / 小红书 / X

---

## 7. 开源协议 + 品牌

- 代码：**MIT**（方便后面做商业化时不被 GPL 传染）
- 产品名：**JORAN Pocket**（保留；你的品牌）
- 域名：`joran.dev` 或 `pocket.joran.dev`（你决定）
- 仓库：新仓库 `joran-pocket`（旧的 ttyd 版本归档到 `v0-ttyd` 分支保留历史）

---

## 8. 已知风险 + 缓解

| 风险 | 概率 | 缓解 |
|---|---|---|
| 5-10% 双方严格 NAT 下打不洞 | 中 | MVP 先不加 TURN，失败提示 "换个网络"；v0.2 加 coturn（Oracle Cloud Free Tier 永久免费能跑） |
| Anthropic Remote Control 抢先占领市场 | 高 | 差异化 = 协议桥（approval sheet、tool 卡片）+ 零账号 + 中国可用 |
| Cloudflare Worker 免费额度超了 | 低 | 监控；超了换 Deno Deploy（同样免费）或加 $5/mo 付费版 |
| Mac helper 二进制被 macOS Gatekeeper 拦 | 中 | 第一版要求用户 `chmod +x` + 右键"打开"；v0.2 申请 Apple Developer ID ($99/年) 签名 |
| 用户家里路由器 CGNAT 把 STUN 也打不了 | 低 | 很少见；同上 TURN 缓解 |

---

## 9. 待你确认的决策点

在我开始写代码前你需要拍板：

**A. 域名** — 你是想用已有的？还是买个新的（我推荐 `.dev`，Google 强制 HTTPS 免费证书）？这个决定了 Cloudflare Pages 绑什么自定义域。如果暂时没域名，先用 `*.pages.dev` 免费子域也能跑。

**B. 仓库** — 新建 `joran-pocket` replace 掉现有那个？还是现有那个把旧代码归档到 `v0-ttyd` 分支？

**C. 产品名** — 还是 "JORAN Pocket"？

**D. 开发节奏** — 你想：
    - D1：我赶紧把信令 Worker 先跑起来给你看通不通（~30 分钟）
    - D2：还是先把整条信令+Mac helper+PWA 最小 demo 打通（~3-5 天）再给你看一次

E. **下一步该不该先派 Agent 去调研 WebRTC 的具体坑**（pion 在 Mac 上的已知 bug、Safari iOS WebRTC 的特殊行为等）？还是直接开写、撞坑再说？

回复 A-E 其中任意能拍的。开发可以并行，你中间随时可以改主意。
