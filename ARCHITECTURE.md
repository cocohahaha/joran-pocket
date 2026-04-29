# JORAN Pocket — 技术架构

**设计目标**：任何一个 Claude Code 用户，在自己 Mac 上跑一个二进制 + 手机浏览器打开网址，就能看自己的终端、驱动自己的 Claude —— **零账号、零订阅、零信用卡**。

## 0. 三条铁律
1. **终端用户对外零账号**：不注册 Cloudflare、不装 Tailscale
2. **纯 P2P**：终端数据不经过任何第三方服务器
3. **on-demand 链接**：链接只在用户显式 `pocket attach` 后才生效

---

## 1. 全栈拓扑图

```
┌──────────────────────┐                            ┌──────────────────────┐
│   iPhone Safari      │                            │   Mac (你的电脑)     │
│   (PWA Guest)        │                            │                      │
│                      │                            │  ┌────────────────┐  │
│  React + xterm.js    │                            │  │ Terminal.app   │  │
│  + WebRTC client     │                            │  │  pocket attach │  │
│                      │                            │  └───────┬────────┘  │
│         ▲            │                            │          │           │
│         │            │                            │          ▼           │
│         │ DataChannel│                            │  ┌────────────────┐  │
│         │ (DTLS/SCTP)│   1) 信令握手 (短)         │  │ tmux server    │  │
│         │            │ ◄──────────────────────►   │  │ (-L pocket)    │  │
│         │            │                            │  │   pocket sess. │  │
│         │            │                            │  │   ↑↑ pane      │  │
│         │ 2) 直连 P2P│                            │  └────┬─┬─────────┘  │
│         │ (终端字节) │                            │       │ │ pty (PTY) │
│         └────────────┼────────────────────────────┼───────┘ │            │
│                      │                            │         ▼            │
│                      │                            │  ┌────────────────┐  │
└──────────────────────┘                            │  │ pocket helper  │  │
                                  ▲                 │  │ (Go binary)    │  │
                                  │                 │  │  - WebRTC peer │  │
                                  │ /api/register   │  │  - tmux client │  │
                                  │ /api/pair/X/ws  │  │  - caffeinate  │  │
              ┌───────────────────┴─────────────┐   │  └────────┬───────┘  │
              │  Cloudflare Pages + Workers     │   │           │          │
              │  (joran-pocket.pages.dev)       │   │           ▼          │
              │  ┌──────────────────────────┐   │   │  ~/.pocket/active    │
              │  │ Pages Functions           │   │   │  ~/.pocket/url.txt   │
              │  │   POST /api/register       │   │   │  ~/.pocket/code.txt  │
              │  │   GET  /api/pair/X/ws      │   │   │  (state markers)     │
              │  └──────────┬───────────────┘   │   └──────────────────────┘
              │             ▼                    │
              │  ┌──────────────────────────┐   │
              │  │ PairingSession           │   │
              │  │ (Durable Object)          │   │
              │  │  - host slot + guest slot │   │
              │  │  - relay offer/answer/ICE │   │
              │  │  - GC alarm 60s           │   │
              │  └──────────────────────────┘   │
              │                                  │
              │  Pages 静态资源 (/, /p/<code>)  │
              │   ├── index.html                 │
              │   ├── /assets/index-XXX.js       │
              │   └── service worker             │
              └──────────────────────────────────┘
```

> **关键**：终端字节走 P2P DTLS DataChannel — 不经过 Cloudflare。
> Cloudflare 只负责 SDP/ICE 握手 (大约 2KB JSON, 持续 ≤10s)。

---

## 2. 激活生命周期 (on-demand 链接)

```
       Mac 开机                    用户行为                  helper 状态
       ────────                    ────────                  ──────────

  ┌─────────────┐
  │ launchd 启动│
  └──────┬──────┘
         │ 调度 LaunchAgent
         ▼                                                  ┌─────────┐
  ┌─────────────┐                                           │  IDLE   │
  │ helper boot │ → 删 active / url.txt / code.txt          │ ✗ DO    │
  │             │   开 tmux pty (但不注册)                  │ ✗ 链接  │
  └─────────────┘                                           │ ✗ caf-  │
                                                            │   feinate│
                                                            └────┬────┘
                                                                 │
                       ┌─────────────────────┐                   │
                       │ user: pocket attach │                   │
                       └──────────┬──────────┘                   │
                                  │ touch ~/.pocket/active        │
                                  │                               │
                                  │ helper 250ms 内检测            │
                                  │                              ▼
                                  │                         ┌─────────┐
                                  │                         │ ACTIVE  │
                                  │                         │ ✓ 注册新│
                                  │                         │   码    │
                                  │                         │ ✓ 写    │
                                  │                         │   url.txt│
                                  │                         │ ✓ 启动  │
                                  │                         │  caffei-│
                                  │                         │  nate   │
                                  │                         │ ✓ iMess │
                                  │                         │ ✓ Pair  │
                                  │                         │   loop  │
                                  │                         └────┬────┘
                                  │ 等 url.txt (≤15s)             │
                                  │ tmux refresh-client            │
                                  │ exec tmux attach               │
                                  ▼                               │
                       ┌─────────────────────┐                    │
                       │ Terminal 进入 tmux   │                    │
                       └─────────────────────┘                    │
                                                                  │
                       ┌─────────────────────┐                    │
                       │ user: pocket sleep  │                    │
                       └──────────┬──────────┘                    │
                                  │ rm ~/.pocket/active            │
                                  │ helper 2s 内检测               │
                                  │                              ▼
                                  │                         ┌─────────┐
                                  │                         │  IDLE   │
                                  │                         │ ✗ 关 PC │
                                  │                         │ ✗ 停 caf │
                                  │                         │ ✗ 删 url│
                                  │                         │ ✗ 删 code│
                                  │                         └─────────┘
```

**安全特性**：
- Mac 开机默认 IDLE，没人能用 URL 进来
- `pocket attach` 触发：才注册 / 才写 url / 才推 iMessage / 才不熄屏
- `pocket sleep` 立即吊销链接

---

## 3. 一次手机连接的数据流

```
phone Safari            Cloudflare DO              Mac helper
────────────            ─────────────              ──────────

打开 /p/CODE
PWA 加载, React 初始化
       │
       │  WS /api/pair/CODE/ws?role=guest
       ├──────────────────────────────►│
       │                               │ DO bootstrap (此 code)
       │ ◄────hello role=guest─────────┤
       │                               │
       │ ◄──peer-joined role=host──────┤  (host slot 已被 helper 占)
       │                               ├──peer-joined role=guest──►│
       │                               │                            │
       │                               │ ◄──────offer SDP───────────┤
       │ ◄────offer SDP────────────────┤                            │
       │ acceptOffer + createAnswer    │                            │
       ├──── answer SDP ──────────────►│ ────answer SDP───────────►│ setRemoteDesc
       │                               │                            │
       ├──ICE candidate(s) trickle────►│ ──ICE candidate(s)───────►│
       │ ◄──ICE candidate(s) trickle───┤ ◄──ICE candidate(s)───────┤
       │                               │                            │
       │ ╔════════════════════════════════════════════════════════╗ │
       │ ║      P2P DTLS 直连 (Cloudflare 不再参与)                ║ │
       │ ╠════════════════════════════════════════════════════════╣ │
       │ ║  pty DataChannel             sidechannel DC            ║ │
       │ ║  ────────────────             ──────────────            ║ │
       │ ║  Mac→phone:  tmux 渲染字节   Mac→phone:                ║ │
       │ ║                              {pane_size,windows,       ║ │
       │ ║                               claude_state}            ║ │
       │ ║                                                        ║ │
       │ ║  phone→Mac:  {type:"input",   phone→Mac:               ║ │
       │ ║              data}            {select_window,          ║ │
       │ ║                               new_window,...}          ║ │
       │ ╚════════════════════════════════════════════════════════╝ │
       │
       ▼
xterm.js 渲染：
 - DOM renderer (iOS Safari 比 canvas 稳)
 - @xterm/addon-unicode11 (CJK = 2 列, 必须)
 - .xterm-rows white-space:pre  (保留 ASCII 缩进)
 - .xterm-viewport overflow:visible (让外层接管 scroll)
 - 收到 pane_size 才 term.resize → 三步强制 paint
```

---

## 4. 进程 / 文件清单

### 进程 (Mac)
| 进程 | 启动者 | 用途 |
|------|--------|------|
| `pocket` (helper) | LaunchAgent `com.joranpocket.helper` | 长跑守护，IDLE/ACTIVE 状态机 |
| `caffeinate -d -i -m -u` | helper, **仅 ACTIVE 时** | 防熄屏 / 防睡眠 / 防屏保 |
| `tmux server (-L pocket)` | helper ensureSession | 隔离的 tmux server |
| `tmux attach-session` ×2 | helper PTY + 用户 Mac Term | 各自一个 tmux client |

### 状态文件 (`~/.pocket/`)
| 文件 | 写入者 | 读取者 | 含义 |
|------|--------|--------|------|
| `active` | `pocket attach` / `pocket sleep` | helper poll 250ms | 是否激活 |
| `url.txt` | helper (注册成功后) | `pocket attach` / `pocket url` | 当前公开 URL |
| `code.txt` | helper | helper (重连用) | 当前 sticky code |
| `imessage-to.txt` | 用户手动 | helper | 推送目标 (邮箱/手机号) |
| `tmux.conf` | helper WriteTmuxConf | tmux server | window-size / mouse off |
| `helper.log` `helper.err` | LaunchAgent 重定向 | 调试 | 运行日志 |

### CLI 子命令
| 命令 | 作用 |
|------|------|
| `pocket install` | 装 LaunchAgent (开机自启 helper, 但 helper IDLE) |
| `pocket uninstall` | 卸 LaunchAgent |
| **`pocket attach`** | **激活 helper + 注册 URL + iMessage + tmux 接管** |
| **`pocket sleep`** | **立即吊销链接 (helper 转回 IDLE)** |
| `pocket url` | 输出当前 URL (IDLE 时无) |
| `pocket status` | 查 LaunchAgent / 进程 / 状态 / URL |

---

## 5. 关键技术决策

### 渲染端 (PWA)
| 决策 | 原因 |
|------|------|
| xterm.js DOM renderer | iOS Safari 上 canvas/WebGL 在非整数 DPR 下字宽算错 |
| `@xterm/addon-unicode11` | 默认 v6 把中文当 1 列，跟 tmux (2 列) 错位 |
| `.xterm-rows white-space:pre` | `nowrap` 会合并连续空格 → 终端缩进消失 |
| `.xterm-viewport overflow:visible` | 让外层 div 接管 scroll，iOS touch 不被吃掉 |
| `will-change` + `contain` 提示 | iOS Safari 单独 compositor 层，避免 lazy-paint |
| 三步强制 paint (refresh + RAF×2 + transform 切换) | resize 后立即可见，不需要划屏 |

### 连接端 (helper)
| 决策 | 原因 |
|------|------|
| 默认 IDLE 不注册 | 链接 on-demand,泄露窗口窄 |
| LANG=en_US.UTF-8 | LaunchAgent 默认 C locale → tmux 把 \\t 替换成 _ |
| sticky code 失败 5 次自动旋转 | Cloudflare DO host 槽偶尔 ghost 占用 |
| Pair fail < 2s 才退避 | 真实连接断开不退避，保正常重连快 |
| `tmux refresh-client -t TTY` (per-client) | resize 后强制每个 client 重绘 → 投屏即时 |
| pane_size 200ms 采样 | 比 500ms 响应快 2.5x, 几乎察觉不到 |

### 信令服务 (Cloudflare)
| 决策 | 原因 |
|------|------|
| Pages Functions 而非独立 Worker | PWA 静态 + 信令 API 同源, 省一个 deploy |
| Durable Object per code | 天然 host/guest slot 状态隔离 |
| GC alarm 60s + idle 10min | 不耗资源, 也不卡死 |
| 不存终端字节 | 仅中转 SDP/ICE (~2KB), 隐私零保留 |

---

## 6. 不熄屏 / 不睡眠

`caffeinate -d -i -m -u` (helper ACTIVE 期间运行)：
- `-d` 阻止显示器休眠 (这就是"不熄屏")
- `-i` 阻止系统空闲休眠
- `-m` 阻止磁盘休眠
- `-u` 标记用户活跃 (重置所有 idle 计时器)

进入 IDLE (pocket sleep / 退出) → caffeinate 跟着死 → Mac 恢复正常自动休眠。
