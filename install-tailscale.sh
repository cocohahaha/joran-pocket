#!/usr/bin/env bash
# JORAN Pocket — 5 分钟搞定手机操控 Mac（Tailscale + 自带 SSH 路线）
#
# 灵感来自 https://mp.weixin.qq.com/s/hoZ2ryJDSBNoiXfbrUKUdg
#
# 这条路线做的事：
#   1) 装 Tailscale（WireGuard 私有组网，自动 NAT 穿透，免费）
#   2) 开启 Mac 系统自带 SSH 服务器
#   3) 装 tmux + 配一次自动接入 'pocket' 会话
#   4) 打印 iPhone 端 3 步配置说明（Tailscale App + Termius）
#
# 相比之前 ttyd + Cloudflare Tunnel 的方案：
#   - 网络稳：P2P 直连，不走任何公网中继
#   - 配置少：无需域名、无需账号注册（用 Google/GitHub/Apple SSO 登 Tailscale）
#   - 原生 SSH：iOS 输入无 xterm.js 预测输入 bug
#   - Anthropic Remote Control 要的 VPN，这条路用 Tailscale 自带 VPN 一起解决
#
# 安全：
#   - Tailscale 内网只有你自己登录的设备能看到 Mac，外人扫不到
#   - SSH 用你 Mac 登录密码（或配 SSH 公钥更佳）
#
# 卸载：
#   sudo systemsetup -setremotelogin off
#   /Applications/Tailscale.app 右键 → Uninstall Tailscale
#   编辑 ~/.zshrc 删掉 "JORAN Pocket auto-attach" 段落

set -euo pipefail

# --- 样式 ---
say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m ⚠\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m ✗\033[0m %s\n' "$*" >&2; exit 1; }
ask()  { printf '\033[1;35m ? \033[0m%s' "$*"; }

# --- 前置检查 ---
[[ "$(uname -s)" == "Darwin" ]] || err "只支持 macOS"
command -v brew >/dev/null || err "需要先装 Homebrew：https://brew.sh"

cat <<'BANNER'

 ┌──────────────────────────────────────────────────────────┐
 │  JORAN Pocket — Tailscale 路线 · 5 分钟完事              │
 │                                                          │
 │  手机打开 Termius → 点一下 → 连进家里 Mac → 跑 claude    │
 └──────────────────────────────────────────────────────────┘

BANNER

# ============================================================
#  步骤 1 — 装 Tailscale
# ============================================================
say "步骤 1/5：检测 / 安装 Tailscale"

if [ ! -d /Applications/Tailscale.app ]; then
  say "从 Homebrew 装 Tailscale..."
  brew install --cask tailscale
else
  ok "Tailscale.app 已安装"
fi

TAILSCALE=/Applications/Tailscale.app/Contents/MacOS/Tailscale
[ -x "$TAILSCALE" ] || err "Tailscale CLI 找不到：$TAILSCALE"

# ============================================================
#  步骤 2 — 登录 Tailscale（必须浏览器 OAuth）
# ============================================================
say "步骤 2/5：登录 Tailscale"

ts_ready() {
  "$TAILSCALE" status --self --json 2>/dev/null | \
    python3 -c 'import json,sys
try:
    j=json.load(sys.stdin); s=j.get("Self",{}) or {}
    print(s.get("DNSName","").rstrip("."))
except: pass' 2>/dev/null
}

TS_HOST="$(ts_ready)"
if [ -z "$TS_HOST" ]; then
  say "打开 Tailscale App —— 请在菜单栏图标里点 'Log In'"
  say "用 Google / GitHub / Apple ID 都行（免费账号 100 台设备）"
  open -a Tailscale
  echo
  ask "登录完成后按回车继续（或 Ctrl-C 退出）: "
  read -r _
  TS_HOST="$(ts_ready)"
fi

if [ -z "$TS_HOST" ]; then
  err "Tailscale 还是没登上。请确认菜单栏图标 → 'Connected' 绿灯，然后重跑本脚本。"
fi
ok "Tailscale 已登录，本机主机名：$TS_HOST"

# ============================================================
#  步骤 3 — 开启 Mac SSH 服务
# ============================================================
say "步骤 3/5：开启 Mac 的 SSH 远程登录"

# 不需要 sudo 就能查状态（读 plist）
if launchctl print-disabled system 2>/dev/null | grep -q '"com.openssh.sshd" => false'; then
  ok "SSH 已经开着"
elif sudo -n true 2>/dev/null; then
  # 有免密 sudo，顺手做
  sudo systemsetup -setremotelogin on 2>&1 | grep -v '^$' || true
  ok "SSH 已开启"
else
  echo
  warn "需要 sudo 开启 SSH —— 请自己执行下面这一行（输你 Mac 登录密码）："
  echo
  echo "    sudo systemsetup -setremotelogin on"
  echo
  ask "跑完后按回车继续: "
  read -r _
fi

# ============================================================
#  步骤 4 — tmux + 自动接入 'pocket' 会话
# ============================================================
say "步骤 4/5：配 tmux 自动接入"

command -v tmux >/dev/null || brew install tmux
ok "tmux 已装（$(tmux -V)）"

ZSHRC="$HOME/.zshrc"
MARKER='# === JORAN Pocket auto-attach (手机 SSH 进来自动接 tmux) ==='
if grep -qF "$MARKER" "$ZSHRC" 2>/dev/null; then
  ok "~/.zshrc 已经配好，跳过"
else
  cat >> "$ZSHRC" <<EOF

$MARKER
if [[ -n "\$SSH_TTY" && -z "\$TMUX" ]]; then
  tmux new-session -A -s pocket
fi
# === end JORAN Pocket ===
EOF
  ok "~/.zshrc 已追加（SSH 进来自动 tmux attach -s pocket）"
fi

# ============================================================
#  步骤 5 — iPhone 端指引
# ============================================================
MY_USER="$(id -un)"
cat <<EOF

 ╔══════════════════════════════════════════════════════════╗
 ║  ✅ Mac 侧配置完成                                       ║
 ╚══════════════════════════════════════════════════════════╝

 主机地址：$TS_HOST
 用户名   ：$MY_USER

 ──────────────────────────────────────────────────────────
  步骤 5/5 — iPhone 3 步：
 ──────────────────────────────────────────────────────────

  (A) App Store 搜 "Tailscale" → 装 → 登同一个账号
      → 打开总开关，授权 VPN 配置（iOS 会弹系统提示）

  (B) App Store 搜 "Termius" → 装（免费版够用）
      其他选项：Blink Shell（\$20/年，更专业，带 Mosh）

  (C) Termius 里添加 Host：
        Alias    : Pocket
        Hostname : $TS_HOST
        Username : $MY_USER
        Port     : 22
        Password : 你 Mac 的登录密码
      保存 → 点 Host 连接

  连上之后自动进 'pocket' tmux 会话，直接：

        claude          # 或 opencode / codex

  关手机 / 断网 / 换 Wi-Fi / 换蜂窝 / 上飞机
  → 重开 Termius 再连 → 会话原样还在，Claude 上下文不丢

 ──────────────────────────────────────────────────────────
  故障排查
 ──────────────────────────────────────────────────────────

  验证 Tailscale：
      $TAILSCALE status | head -5

  验证 SSH：
      sudo systemsetup -getremotelogin
      # 应输出 "Remote Login: On"

  手动进 tmux（如果 SSH 自动接没起）：
      tmux attach -t pocket
      # 或 tmux new -s pocket 创建

  断开 tmux 不杀会话：Ctrl-b d
  重连后 tmux ls 看在跑哪些会话

EOF

ok "完事，手机那 3 步做完就能用了"
