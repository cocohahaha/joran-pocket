#!/usr/bin/env bash
# JORAN Pocket — install script for end users.
#
# Usage (paste into Mac Terminal):
#   curl -fsSL https://joran-pocket.pages.dev/install.sh | bash
#
# or from source checkout:
#   bash scripts/install.sh

set -euo pipefail

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m ⚠\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m ✗\033[0m %s\n' "$*" >&2; exit 1; }

# --- Platform check ---
[[ "$(uname -s)" == "Darwin" ]] || err "macOS only (got $(uname -s))"

# --- Install destination ---
POCKET_HOME="${POCKET_HOME:-$HOME/.pocket}"
BIN_DIR="$POCKET_HOME/bin"
mkdir -p "$BIN_DIR"

# --- Download the helper binary ---
# When deployed, a GitHub Release ships prebuilt helper binaries for both
# macOS architectures. For local dev (source checkout), we build from source.
ARCH="$(uname -m)"  # arm64 or x86_64
case "$ARCH" in
  arm64)  BIN_TAG="darwin-arm64" ;;
  x86_64) BIN_TAG="darwin-amd64" ;;
  *)      err "unsupported arch: $ARCH" ;;
esac

# If run from a source checkout, build locally.
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"
if [ -d "$SRC_DIR/helper" ] && [ -f "$SRC_DIR/helper/go.mod" ]; then
  command -v go >/dev/null || err "Go is required to build from source. Install: brew install go"
  say "Building helper from source ($SRC_DIR/helper)…"
  ( cd "$SRC_DIR/helper" && go build -o "$BIN_DIR/pocket" . )
  ok "Built $BIN_DIR/pocket"
else
  # Download release artifact.
  LATEST_URL="${POCKET_RELEASE_URL:-https://github.com/cocohahaha/joran-pocket/releases/latest/download/pocket-$BIN_TAG}"
  say "Downloading pocket helper ($BIN_TAG)…"
  curl -fSL --retry 3 -o "$BIN_DIR/pocket" "$LATEST_URL" || err "download failed"
  chmod +x "$BIN_DIR/pocket"
  ok "Installed $BIN_DIR/pocket"
fi

# --- Symlink into PATH ---
for d in /opt/homebrew/bin /usr/local/bin; do
  if [ -w "$d" ]; then
    ln -sf "$BIN_DIR/pocket" "$d/pocket"
    ok "Symlinked $d/pocket → $BIN_DIR/pocket"
    break
  fi
done

# --- Signaling endpoint ---
SIG_HOST="${POCKET_SIGNALING:-}"
if [ -z "$SIG_HOST" ]; then
  cat <<EOF

 ──────────────────────────────────────────────────────────
  设置信令服务器地址
 ──────────────────────────────────────────────────────────

 pocket 需要知道你部署的 Cloudflare Worker 地址。
 在你自己的 Cloudflare 账号下部过一次后，地址形如：
     https://joran-pocket-signaling.<你的子域>.workers.dev

 请把它粘过来：
EOF
  read -r SIG_HOST
  [ -z "$SIG_HOST" ] && err "signaling host is required"
fi

# Persist in shell rc.
for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
  [ -f "$rc" ] || continue
  if ! grep -q 'POCKET_SIGNALING' "$rc"; then
    printf '\n# JORAN Pocket\nexport POCKET_SIGNALING=%q\n' "$SIG_HOST" >> "$rc"
    ok "Added POCKET_SIGNALING to $rc"
  fi
done
export POCKET_SIGNALING="$SIG_HOST"

# --- Deps: tmux ---
command -v tmux >/dev/null || {
  say "Installing tmux via Homebrew…"
  command -v brew >/dev/null || err "Homebrew required to install tmux. Install: https://brew.sh"
  brew install tmux
}
ok "tmux: $(tmux -V)"

cat <<EOF

 ╔══════════════════════════════════════════════════════════╗
 ║  ✅ JORAN Pocket 安装完成                                ║
 ╚══════════════════════════════════════════════════════════╝

 用法：

     pocket

 打印一个 6 位配对码 + 网址。手机 Safari 打开网址
 （或在 PWA 首页输码），WebRTC P2P 直连你的 Mac 终端。

 卸载：
     rm -f /opt/homebrew/bin/pocket /usr/local/bin/pocket
     rm -rf ~/.pocket

EOF
