#!/usr/bin/env bash
# JORAN Pocket — 一键部署引导脚本
#
# 重要:这个脚本在 *你自己的* Cloudflare 账号下部署 Worker + Pages,
# 不会经过项目作者的账号或配额。每个 Mac 用户的部署都是隔离的。
#
# 适用于:第一次跑这个项目的人。在 Mac 上完成:
#   1. 检查 / 装齐依赖 (Homebrew, Go, Node, tmux, jq)
#   2. 克隆 / 拉取仓库
#   3. wrangler login 进你自己的 Cloudflare 账号
#   4. 给你的部署生成全局唯一名 (避免和别人撞名)
#   5. 部署你自己的信令 Worker (free tier, 无信用卡)
#   6. 部署 PWA 到你自己的 Cloudflare Pages
#   7. 编译 helper + 装到 PATH (绑定到上面两个 URL)
#   8. 选 iMessage 接收方 + 发测试消息验证
#   9. 装 LaunchAgent (开机自启,默认 IDLE)
#  10. 端到端连通性测试
#
# 用法:
#   curl -fsSL https://raw.githubusercontent.com/cocohahaha/joran-pocket/main/scripts/setup.sh | bash
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
  local prompt="$1"
  local default="${2:-}"
  local reply
  if [ -n "$default" ]; then
    printf '\n  \033[1m? %s\033[0m \033[2m[%s]\033[0m: ' "$prompt" "$default"
  else
    printf '\n  \033[1m? %s\033[0m: ' "$prompt"
  fi
  read -r reply </dev/tty || reply=""
  [ -z "$reply" ] && [ -n "$default" ] && reply="$default"
  printf '%s' "$reply"
}

confirm() {
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

banner "JORAN Pocket — 在你自己 Cloudflare 账号下部署" \
       "约 5 分钟。终端字节走 P2P,只有 SDP/ICE 进你的免费 Worker。"

# ---------- 0. Homebrew ----------
say "0/10  Homebrew"
if ! command -v brew >/dev/null 2>&1; then
  warn "Homebrew 未装。"
  echo "    安装命令 (官方):"
  echo "      /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
  if confirm "现在帮你装 Homebrew?"; then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  else
    err "Homebrew 是必需的。"
  fi
fi
ok "Homebrew $(brew --version | head -1 | awk '{print $2}')"

# ---------- 1. 依赖 ----------
say "1/10  依赖 (Go / Node / tmux / jq)"
needs=()
command -v go    >/dev/null || needs+=(go)
command -v node  >/dev/null || needs+=(node)
command -v tmux  >/dev/null || needs+=(tmux)
command -v jq    >/dev/null || needs+=(jq)
if [ ${#needs[@]} -gt 0 ]; then
  echo "    缺:${needs[*]}"
  if confirm "用 brew 装齐?"; then
    brew install "${needs[@]}"
  else
    err "依赖必须满足。手动跑:brew install ${needs[*]}"
  fi
fi
ok "go    $(go version | awk '{print $3}')"
ok "node  $(node --version)"
ok "tmux  $(tmux -V | awk '{print $2}')"
ok "jq    $(jq --version)"

# ---------- 2. 源码 ----------
say "2/10  定位源码"
SRC_DIR=""

if [ -f "${BASH_SOURCE[0]:-$0}" ]; then
  candidate="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")"/.. && pwd 2>/dev/null || echo "")"
  if [ -n "$candidate" ] && [ -d "$candidate/helper" ] && [ -d "$candidate/signaling" ] && [ -d "$candidate/pwa" ]; then
    SRC_DIR="$candidate"
  fi
fi
if [ -z "$SRC_DIR" ] && [ -d "./helper" ] && [ -d "./signaling" ] && [ -d "./pwa" ]; then
  SRC_DIR="$(pwd)"
fi
if [ -z "$SRC_DIR" ]; then
  SRC_DIR="${POCKET_SRC:-$HOME/joran-pocket}"
  if [ ! -d "$SRC_DIR/.git" ]; then
    echo "    没找到源码,从 GitHub 克隆到 $SRC_DIR"
    git clone --depth 1 https://github.com/cocohahaha/joran-pocket.git "$SRC_DIR"
  else
    echo "    已存在 $SRC_DIR — 拉取更新"
    ( cd "$SRC_DIR" && git pull --ff-only ) || warn "git pull 失败,继续用本地版本"
  fi
fi
ok "源码:$SRC_DIR"
cd "$SRC_DIR"

# ---------- 3. Cloudflare 登录 ----------
say "3/10  你的 Cloudflare 账号"
echo "    项目作者不会看到你的部署 — 这一步把你登入你 *自己的* Cloudflare 账号。"
echo "    没账号? 5 秒注册:https://dash.cloudflare.com/sign-up (无信用卡)"

( cd "$SRC_DIR/signaling" && [ -d node_modules ] || npm install --silent ) >/dev/null 2>&1 || true
WRANGLER=( npx --prefix "$SRC_DIR/signaling" -y wrangler )

if ! "${WRANGLER[@]}" whoami 2>/dev/null | grep -qiE "logged in|getting user info|email"; then
  echo ""
  echo "    准备弹出浏览器登录..."
  if confirm "继续?"; then
    "${WRANGLER[@]}" login || err "Cloudflare 登录失败"
  else
    err "需要登录 Cloudflare 才能继续"
  fi
fi

WHOAMI_OUT="$("${WRANGLER[@]}" whoami 2>&1 || true)"
CF_EMAIL="$(echo "$WHOAMI_OUT" | grep -Eo '[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+' | head -1 || true)"
CF_ACCOUNT_ID="$(echo "$WHOAMI_OUT" | grep -Eo '[a-f0-9]{32}' | head -1 || true)"
ok "Cloudflare:${CF_EMAIL:-(unknown)}"

# ---------- 4. 生成唯一部署名 ----------
say "4/10  你的部署唯一名"
echo "    Cloudflare Workers/Pages 的项目名是全局唯一的。"
echo "    脚本会从你的账号信息生成一个稳定的后缀,避免和别人撞名。"

# Persistent suffix — first run derives it, subsequent runs reuse so deployments are idempotent.
DEPLOY_HOME="$HOME/.pocket"
mkdir -p "$DEPLOY_HOME"
SUFFIX_FILE="$DEPLOY_HOME/deploy-suffix"

if [ ! -f "$SUFFIX_FILE" ] || [ ! -s "$SUFFIX_FILE" ]; then
  if [ -n "$CF_ACCOUNT_ID" ]; then
    # Hash account ID → first 8 hex of sha256
    SUFFIX="$(printf '%s' "$CF_ACCOUNT_ID" | shasum -a 256 | cut -c1-8)"
  else
    # Fallback: random 8 hex
    SUFFIX="$(head -c 4 /dev/urandom | xxd -p)"
  fi
  printf '%s' "$SUFFIX" > "$SUFFIX_FILE"
fi
SUFFIX="$(cat "$SUFFIX_FILE")"

WORKER_NAME="joran-pocket-signaling-${SUFFIX}"
PAGES_NAME="joran-pocket-${SUFFIX}"

ok "Worker name :  $WORKER_NAME"
ok "Pages name  :  $PAGES_NAME"
ok "(后缀 $SUFFIX 存在 $SUFFIX_FILE,后续 setup 重跑会复用)"

# ---------- 5. 改写 wrangler.toml ----------
say "5/10  改写 wrangler.toml 用上你的唯一名"
# signaling/wrangler.toml: change "name"
SIG_TOML="$SRC_DIR/signaling/wrangler.toml"
[ -f "$SIG_TOML.bak" ] || cp "$SIG_TOML" "$SIG_TOML.bak"
# Replace first `name = "..."` line
awk -v n="$WORKER_NAME" '
  BEGIN { done=0 }
  /^name = "/ && !done { print "name = \"" n "\""; done=1; next }
  { print }
' "$SIG_TOML.bak" > "$SIG_TOML"
ok "signaling/wrangler.toml → name = \"$WORKER_NAME\""

# pwa/wrangler.toml: change "name" + DO binding "script_name"
PWA_TOML="$SRC_DIR/pwa/wrangler.toml"
[ -f "$PWA_TOML.bak" ] || cp "$PWA_TOML" "$PWA_TOML.bak"
awk -v p="$PAGES_NAME" -v w="$WORKER_NAME" '
  BEGIN { name_done=0 }
  /^name = "/ && !name_done { print "name = \"" p "\""; name_done=1; next }
  /^script_name = "/ { print "script_name = \"" w "\""; next }
  { print }
' "$PWA_TOML.bak" > "$PWA_TOML"
ok "pwa/wrangler.toml → name = \"$PAGES_NAME\", script_name = \"$WORKER_NAME\""

# ---------- 6. 部署信令 Worker ----------
say "6/10  部署信令 Worker (你的 CF 账号)"
echo "    这个 Worker ${B "不"} 中转任何终端字节,只交换 ~2KB 握手元数据。"
(
  cd "$SRC_DIR/signaling"
  [ -d node_modules ] || npm install
  set +e
  out="$(npx wrangler deploy 2>&1)"
  status=$?
  set -e
  echo "$out" | sed 's/^/      /'
  [ "$status" -eq 0 ] || err "信令 Worker 部署失败 (上面 ↑ 的输出)"
  worker_url="$(echo "$out" | grep -oE 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -1)"
  echo "$worker_url" > /tmp/pocket_worker_url
)
WORKER_URL="$(cat /tmp/pocket_worker_url 2>/dev/null || echo "")"
ok "Worker:${WORKER_URL:-(?)}"

# ---------- 7. 部署 PWA ----------
say "7/10  部署 PWA (Cloudflare Pages,你的 CF 账号)"
(
  cd "$SRC_DIR/pwa"
  [ -d node_modules ] || npm install
  echo "    构建静态资源..."
  npm run build >/dev/null 2>&1 || npm run build
  echo "    部署 to Cloudflare Pages (project: $PAGES_NAME)..."
  set +e
  out="$(npx wrangler pages deploy dist --project-name="$PAGES_NAME" --branch=main --commit-dirty=true 2>&1)"
  status=$?
  set -e
  echo "$out" | tail -10 | sed 's/^/      /'
  [ "$status" -eq 0 ] || err "Pages 部署失败 (上面 ↑ 的输出)"
  # Take the *.pages.dev hostname (not the per-deploy preview URL)
  pages_url="$(echo "$out" | grep -oE "https://${PAGES_NAME}\.pages\.dev" | head -1)"
  if [ -z "$pages_url" ]; then
    pages_url="$(echo "$out" | grep -oE 'https://[a-zA-Z0-9.-]+\.pages\.dev' | tail -1)"
  fi
  echo "$pages_url" > /tmp/pocket_pages_url
)
PAGES_URL="$(cat /tmp/pocket_pages_url 2>/dev/null || echo "")"
[ -n "$PAGES_URL" ] || PAGES_URL="https://${PAGES_NAME}.pages.dev"
ok "PWA:$PAGES_URL"

# ---------- 8. 编译 + 安装 helper ----------
say "8/10  编译并安装 helper"
mkdir -p "$HOME/.pocket/bin"
( cd "$SRC_DIR/helper" && go build -o "$HOME/.pocket/bin/pocket" . )
ok "Built $HOME/.pocket/bin/pocket"

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
[ -n "$LINK_TARGET" ] || warn "没装到 PATH。手动加 $HOME/.pocket/bin 到 PATH"
ok "${LINK_TARGET:-$HOME/.pocket/bin/pocket} 可用"

# Ad-hoc codesign so launchd 不会因为代码签名拒运
codesign --force -s - "$HOME/.pocket/bin/pocket" 2>/dev/null || true

# ---------- 9. iMessage 接收方 ----------
say "9/10  iMessage 推送目标"
echo "    pocket attach 时会把链接推到你的 iPhone。"
echo "    可以是:邮箱 (Apple ID) 或手机号 (+1xxx 格式)"

current_to=""
[ -f "$HOME/.pocket/imessage-to.txt" ] && current_to="$(cat "$HOME/.pocket/imessage-to.txt" | tr -d '[:space:]')"

while true; do
  IM_TO="$(ask "iMessage 接收方" "${current_to:-}")"
  IM_TO="$(echo "$IM_TO" | tr -d '[:space:]')"
  if [ -z "$IM_TO" ]; then warn "不能为空"; continue; fi
  break
done

mkdir -p "$HOME/.pocket"
echo "$IM_TO" > "$HOME/.pocket/imessage-to.txt"
chmod 600 "$HOME/.pocket/imessage-to.txt"
ok "保存到 ~/.pocket/imessage-to.txt"

if confirm "现在发一条测试消息验证 Messages 能用?"; then
  osascript <<EOF 2>/dev/null || warn "Messages.app 调用失败 — 检查 Messages 是否已登录"
tell application "Messages"
  try
    set theService to 1st service whose service type = iMessage
    set theBuddy to buddy "$IM_TO" of theService
    send "✅ JORAN Pocket setup 测试 — 你的部署:$PAGES_URL" to theBuddy
  end try
end tell
EOF
  ok "测试消息已发 (检查你的 iPhone)"
fi

# ---------- 10. LaunchAgent + 测试 ----------
say "10/10  装 LaunchAgent + 端到端测试"

# 关键:用你刚部署的 URL,而非项目作者的
export POCKET_SIGNALING="$PAGES_URL"
export POCKET_PWA_URL="$PAGES_URL"

if confirm "装 LaunchAgent (开机自启 helper, 默认 IDLE)?"; then
  "$HOME/.pocket/bin/pocket" install
  ok "LaunchAgent 装好"
fi

echo "    1) PWA URL 健康检查"
HEALTH_URL="$PAGES_URL/api/health"
if curl -sf -m 10 "$HEALTH_URL" 2>/dev/null | grep -q '"ok":true'; then
  ok "$HEALTH_URL → ok:true"
else
  warn "$HEALTH_URL 没回 ok:true。Cloudflare Pages 可能还在传播 (1-2 分钟)。重试:curl -s $HEALTH_URL"
fi

echo "    2) 信令 register 拿 code"
REG_OUT="$(curl -sf -m 10 -X POST "$PAGES_URL/api/register" 2>/dev/null || true)"
if echo "$REG_OUT" | jq -e .code >/dev/null 2>&1; then
  TEST_CODE="$(echo "$REG_OUT" | jq -r .code)"
  ok "POST $PAGES_URL/api/register → code=$TEST_CODE"
else
  warn "register 没返回有效 code。可能 Pages 的 DO binding 还没生效 (1-2 分钟)。"
  warn "如果一直不行,运行 cd $SRC_DIR/pwa && npx wrangler pages deploy dist --project-name=$PAGES_NAME 重试"
fi

echo "    3) helper 状态"
sleep 1
"$HOME/.pocket/bin/pocket" status | sed 's/^/      /'

# ---------- 完成 ----------
banner "✅ 完成,所有部署都在你自己 Cloudflare 账号下" \
       "项目作者看不到你的会话,你的免费配额只服务你一人"

cat <<EOF

  $(B 用法)：

    $(B "pocket attach")    激活 + 把链接推到你 iPhone
    $(B "pocket sleep")     吊销链接 (Mac 恢复正常熄屏)
    $(B "pocket status")    看当前状态
    $(B "pocket url")       打印当前 URL (只在 ACTIVE 时有)

  $(B 你的部署)：

    PWA:       $PAGES_URL
    Worker:    ${WORKER_URL:-https://${WORKER_NAME}.workers.dev}
    iMessage:  $IM_TO
    Helper:    $HOME/.pocket/bin/pocket
    Config:    $HOME/.pocket/

  $(B 卸载)：

    pocket uninstall
    rm -rf ~/.pocket
    rm -f /opt/homebrew/bin/pocket /usr/local/bin/pocket
    # 可选:在 Cloudflare dashboard 删除 Worker / Pages 项目

  下一步:在另一个 Terminal 窗口里跑 $(B "pocket attach") 试试。
  iPhone 会收到 iMessage 链接,点开就能看你的终端。

EOF
