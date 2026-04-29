#!/usr/bin/env bash
# JORAN Pocket — 一键部署引导脚本
#
# 适用于：第一次跑这个项目的人。在自己的 Mac 上完成：
#   1. 检查 / 安装依赖 (Homebrew, Go, Node, tmux, jq)
#   2. 克隆仓库 (如果还没克隆)
#   3. 引导 Cloudflare 登录 (wrangler login)
#   4. 部署你自己的信令 Worker (free tier, 无信用卡)
#   5. 部署 PWA 到 Cloudflare Pages
#   6. 编译并安装 helper 二进制
#   7. 引导你输入 iMessage 接收方 (邮箱 / 手机号)
#   8. 装 LaunchAgent (开机自启)
#   9. 跑端到端连通性测试
#
# 用法 (在 Mac Terminal 里):
#   curl -fsSL https://joran-pocket.pages.dev/setup.sh | bash
#
# 或本地源码:
#   bash scripts/setup.sh

set -euo pipefail

# ---------- 视觉 helpers ----------
B() { printf '\033[1m%s\033[0m' "$*"; }
DIM() { printf '\033[2m%s\033[0m' "$*"; }
say()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[1;33m⚠\033[0m %s\n' "$*" >&2; }
err()  { printf '  \033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

ask() {
  # ask "prompt" [default]
  local prompt="$1"
  local default="${2:-}"
  local reply
  if [ -n "$default" ]; then
    printf '\n  \033[1m? %s\033[0m \033[2m[%s]\033[0m: ' "$prompt" "$default"
  else
    printf '\n  \033[1m? %s\033[0m: ' "$prompt"
  fi
  read -r reply </dev/tty || reply=""
  if [ -z "$reply" ] && [ -n "$default" ]; then
    reply="$default"
  fi
  printf '%s' "$reply"
}

confirm() {
  # confirm "prompt" — returns 0 if yes
  local prompt="$1"
  local reply
  printf '\n  \033[1m? %s\033[0m \033[2m[Y/n]\033[0m: ' "$prompt"
  read -r reply </dev/tty || reply=""
  case "${reply:-y}" in y|Y|yes|YES|"") return 0;; *) return 1;; esac
}

banner() {
  printf '\n'
  printf '  \033[1;33m╔═══════════════════════════════════════════════════════╗\033[0m\n'
  printf '  \033[1;33m║\033[0m   \033[1;37m%s\033[0m\n' "$1"
  if [ -n "${2:-}" ]; then
    printf '  \033[1;33m║\033[0m   \033[2m%s\033[0m\n' "$2"
  fi
  printf '  \033[1;33m╚═══════════════════════════════════════════════════════╝\033[0m\n'
}

# ---------- 平台检查 ----------
[[ "$(uname -s)" == "Darwin" ]] || err "macOS only (got $(uname -s))"

banner "JORAN Pocket — 部署引导" "约 5 分钟。需要免费 Cloudflare 账号 (无信用卡)。"

# ---------- 0. 检查 Homebrew ----------
say "0/9  检查 Homebrew"
if ! command -v brew >/dev/null 2>&1; then
  warn "Homebrew 未安装。"
  echo "    JORAN Pocket 需要 Homebrew 来装 tmux / Go / Node。"
  echo "    安装命令 (官方):"
  echo "      /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
  if confirm "现在帮你装 Homebrew?"; then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  else
    err "Homebrew 是必需的，请先装好再跑这个脚本。"
  fi
fi
ok "Homebrew $(brew --version | head -1 | awk '{print $2}')"

# ---------- 1. 检查依赖 ----------
say "1/9  检查依赖 (Go / Node / tmux / jq)"
needs=()
command -v go    >/dev/null || needs+=(go)
command -v node  >/dev/null || needs+=(node)
command -v tmux  >/dev/null || needs+=(tmux)
command -v jq    >/dev/null || needs+=(jq)
if [ ${#needs[@]} -gt 0 ]; then
  echo "    缺：${needs[*]}"
  if confirm "用 brew 装齐?"; then
    brew install "${needs[@]}"
  else
    err "依赖必须满足。手动跑：brew install ${needs[*]}"
  fi
fi
ok "go    $(go version | awk '{print $3}')"
ok "node  $(node --version)"
ok "tmux  $(tmux -V | awk '{print $2}')"
ok "jq    $(jq --version)"

# ---------- 2. 定位源码 ----------
say "2/9  定位源码"
SRC_DIR=""

# Try: relative to this script
if [ -f "${BASH_SOURCE[0]:-$0}" ]; then
  candidate="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")"/.. && pwd)"
  if [ -d "$candidate/helper" ] && [ -d "$candidate/signaling" ] && [ -d "$candidate/pwa" ]; then
    SRC_DIR="$candidate"
  fi
fi

# Try: pwd
if [ -z "$SRC_DIR" ]; then
  if [ -d "./helper" ] && [ -d "./signaling" ] && [ -d "./pwa" ]; then
    SRC_DIR="$(pwd)"
  fi
fi

# Curl-piped install: clone fresh
if [ -z "$SRC_DIR" ]; then
  SRC_DIR="${POCKET_SRC:-$HOME/joran-pocket}"
  if [ ! -d "$SRC_DIR/.git" ]; then
    echo "    没找到源码，从 GitHub 克隆到 $SRC_DIR"
    git clone --depth 1 https://github.com/cocohahaha/joran-pocket.git "$SRC_DIR"
  else
    echo "    已存在 $SRC_DIR — 拉取更新"
    ( cd "$SRC_DIR" && git pull --ff-only ) || warn "git pull 失败，继续用本地版本"
  fi
fi
ok "源码：$SRC_DIR"
cd "$SRC_DIR"

# ---------- 3. Cloudflare 登录 ----------
say "3/9  Cloudflare 账号"
echo "    这个项目需要你自己有一个 Cloudflare 账号 (免费额度足够，无信用卡)。"
echo "    没账号? 5 秒注册：https://dash.cloudflare.com/sign-up"
echo ""
echo "    我们用 wrangler CLI 登录。它会打开浏览器让你授权。"

# Use the wrangler shipped with the signaling project so version is consistent.
( cd "$SRC_DIR/signaling" && [ -d node_modules ] || npm install --silent ) >/dev/null 2>&1 || true
WRANGLER=( npx --prefix "$SRC_DIR/signaling" -y wrangler )

# whoami: detect if already logged in
if ! "${WRANGLER[@]}" whoami 2>/dev/null | grep -q "logged in"; then
  echo ""
  echo "    准备弹出浏览器登录..."
  if confirm "继续?"; then
    "${WRANGLER[@]}" login || err "Cloudflare 登录失败"
  else
    err "需要登录 Cloudflare 才能继续"
  fi
fi
CF_USER="$("${WRANGLER[@]}" whoami 2>/dev/null | awk -F'\\(' '/email/ {print $1}' | sed 's/.*: *//' | tr -d ' ' || echo unknown)"
ok "Cloudflare 已登录"

# ---------- 4. 部署信令 Worker ----------
say "4/9  部署信令 Worker"
echo "    把 SDP/ICE 中转 Worker 推到你的 Cloudflare 账号下。"
echo "    这里 ${B "不"} 中转任何终端字节，只交换 ~2KB 握手元数据。"
echo ""

(
  cd "$SRC_DIR/signaling"
  [ -d node_modules ] || npm install
  set +e
  out="$(npx wrangler deploy 2>&1)"
  status=$?
  set -e
  echo "$out" | sed 's/^/      /'
  [ "$status" -eq 0 ] || err "信令 Worker 部署失败 (上面 ↑ 的输出)"
  # Find the workers.dev URL
  worker_url="$(echo "$out" | grep -oE 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -1)"
  if [ -z "$worker_url" ]; then
    worker_url="$(echo "$out" | grep -oE 'https://joran-pocket-signaling[a-zA-Z0-9._-]*\.workers\.dev' | head -1)"
  fi
  echo "$worker_url" > /tmp/pocket_worker_url
)
WORKER_URL="$(cat /tmp/pocket_worker_url 2>/dev/null || echo "")"
[ -n "$WORKER_URL" ] || warn "未能从输出里抓到 worker URL，下一步手动确认"
ok "Worker 已部署${WORKER_URL:+: $WORKER_URL}"

# ---------- 5. 部署 PWA ----------
say "5/9  部署 PWA (Cloudflare Pages)"
(
  cd "$SRC_DIR/pwa"
  [ -d node_modules ] || npm install
  echo "    构建静态资源..."
  npm run build >/dev/null 2>&1 || npm run build
  echo "    部署 to Cloudflare Pages..."
  set +e
  out="$(npx wrangler pages deploy dist --project-name=joran-pocket --branch=main --commit-dirty=true 2>&1)"
  status=$?
  set -e
  echo "$out" | tail -8 | sed 's/^/      /'
  [ "$status" -eq 0 ] || err "Pages 部署失败 (上面 ↑ 的输出)"
  pages_url="$(echo "$out" | grep -oE 'https://joran-pocket\.pages\.dev' | head -1)"
  [ -n "$pages_url" ] || pages_url="$(echo "$out" | grep -oE 'https://[a-zA-Z0-9.-]+\.pages\.dev' | head -1)"
  echo "$pages_url" > /tmp/pocket_pages_url
)
PAGES_URL="$(cat /tmp/pocket_pages_url 2>/dev/null || echo "")"
ok "PWA 已部署${PAGES_URL:+: $PAGES_URL}"

# ---------- 6. 编译 + 安装 helper ----------
say "6/9  编译并安装 helper 二进制"
mkdir -p "$HOME/.pocket/bin"
( cd "$SRC_DIR/helper" && go build -o "$HOME/.pocket/bin/pocket" . )
ok "Built $HOME/.pocket/bin/pocket"

# Symlink into PATH
LINK_TARGET=""
for d in /opt/homebrew/bin /usr/local/bin; do
  if [ -d "$d" ] && [ -w "$d" ]; then
    ln -sf "$HOME/.pocket/bin/pocket" "$d/pocket"
    LINK_TARGET="$d/pocket"
    break
  fi
done
if [ -z "$LINK_TARGET" ]; then
  for d in /opt/homebrew/bin /usr/local/bin; do
    if [ -d "$d" ]; then
      sudo ln -sf "$HOME/.pocket/bin/pocket" "$d/pocket" && LINK_TARGET="$d/pocket" && break
    fi
  done
fi
[ -n "$LINK_TARGET" ] || warn "没装到 PATH (无 /opt/homebrew/bin 也无 /usr/local/bin)。手动添加 $HOME/.pocket/bin 到 PATH"
ok "${LINK_TARGET:-$HOME/.pocket/bin/pocket} 可用"

# Codesign (ad-hoc) so launchd 不会因为代码签名拒绝运行
codesign --force -s - "$HOME/.pocket/bin/pocket" 2>/dev/null || true

# ---------- 7. iMessage 接收方 ----------
say "7/9  iMessage 推送目标"
echo "    pocket attach 时会把链接推到你的 iPhone。"
echo "    你想用哪个 iMessage 账号收?"
echo ""
echo "    可以是：邮箱 (Apple ID 邮箱) 或手机号 (+1xxx 格式)"
echo ""

current_to=""
[ -f "$HOME/.pocket/imessage-to.txt" ] && current_to="$(cat "$HOME/.pocket/imessage-to.txt" | tr -d '[:space:]')"

while true; do
  IM_TO="$(ask "iMessage 接收方" "${current_to:-}")"
  IM_TO="$(echo "$IM_TO" | tr -d '[:space:]')"
  if [ -z "$IM_TO" ]; then
    warn "不能为空"
    continue
  fi
  break
done

mkdir -p "$HOME/.pocket"
echo "$IM_TO" > "$HOME/.pocket/imessage-to.txt"
chmod 600 "$HOME/.pocket/imessage-to.txt"
ok "保存到 ~/.pocket/imessage-to.txt"

# Test send: ask if user wants to verify
if confirm "现在发一条测试消息验证 Messages 能用?"; then
  osascript <<EOF 2>/dev/null || warn "Messages.app 调用失败 — 检查 Messages 是否已登录"
tell application "Messages"
  try
    set theService to 1st service whose service type = iMessage
    set theBuddy to buddy "$IM_TO" of theService
    send "✅ JORAN Pocket setup 测试 — 这条到了说明 iMessage 工作正常" to theBuddy
  end try
end tell
EOF
  ok "已发送测试消息 (检查你的 iPhone)"
fi

# ---------- 8. LaunchAgent ----------
say "8/9  装 LaunchAgent (开机自启)"
echo "    登录时 helper 自动起在 IDLE 状态 (默认无链接)。"
echo "    用的时候跑 pocket attach 才激活并推送链接。"
echo ""

# Set env so the LaunchAgent plist points to the right Worker / PWA URLs
export POCKET_SIGNALING="${PAGES_URL:-https://joran-pocket.pages.dev}"
export POCKET_PWA_URL="${PAGES_URL:-https://joran-pocket.pages.dev}"

if confirm "装 LaunchAgent (推荐)?"; then
  "$HOME/.pocket/bin/pocket" install
  ok "LaunchAgent 装好"
fi

# ---------- 9. 端到端连通性测试 ----------
say "9/9  端到端连通性测试"
echo "    1) 检查 PWA URL 能访问"
HEALTH_URL="${PAGES_URL:-https://joran-pocket.pages.dev}/api/health"
if curl -sf -m 10 "$HEALTH_URL" | grep -q '"ok":true'; then
  ok "$HEALTH_URL  → ok:true"
else
  warn "$HEALTH_URL 没回 ok:true。Cloudflare Pages 可能还在传播 (1-2 分钟)。"
fi

echo "    2) 检查信令 /api/register 能拿到 code"
REG_URL="${PAGES_URL:-https://joran-pocket.pages.dev}/api/register"
REG_OUT="$(curl -sf -m 10 -X POST "$REG_URL" 2>/dev/null || true)"
if echo "$REG_OUT" | jq -e .code >/dev/null 2>&1; then
  TEST_CODE="$(echo "$REG_OUT" | jq -r .code)"
  ok "POST $REG_URL → code=$TEST_CODE"
else
  warn "$REG_URL 没返回有效 code。你的 Worker 可能没绑到这个 Pages? 看 ARCHITECTURE.md 的 wrangler.toml 部分。"
fi

echo "    3) 检查 helper 状态"
sleep 1
"$HOME/.pocket/bin/pocket" status | sed 's/^/      /'

# ---------- 完成 ----------
banner "✅ 安装完成" "在任何 Terminal 窗口跑 pocket attach 即可激活"

cat <<EOF

  $(B 用法)：

    $(B "pocket attach")    激活 + 把链接推到你 iPhone
    $(B "pocket sleep")     吊销链接 (Mac 恢复正常熄屏)
    $(B "pocket status")    看当前状态
    $(B "pocket url")       打印当前 URL (只在 ACTIVE 时有)

  $(B 你的部署)：

    PWA:       ${PAGES_URL:-(未抓到)}
    Worker:    ${WORKER_URL:-(未抓到)}
    iMessage:  $IM_TO
    Helper:    $HOME/.pocket/bin/pocket
    Config:    $HOME/.pocket/

  $(B 卸载)：

    pocket uninstall
    rm -rf ~/.pocket /opt/homebrew/bin/pocket /usr/local/bin/pocket

  下一步：在另一个 Terminal 窗口里跑 $(B "pocket attach") 试试。
  iPhone 上会收到 iMessage 链接，点开就能看你的终端。

EOF
