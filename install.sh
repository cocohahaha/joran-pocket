#!/usr/bin/env bash
# JORAN Pocket — one-command installer.
#
# Installs tmux + ttyd + cloudflared (via Homebrew), writes launchd agents,
# configures tmux for mobile use, protects the public URL with HTTP basic auth.
#
# Usage:
#   bash install.sh             Interactive: prompts for password if not set
#   POCKET_USER=u POCKET_PASS=p bash install.sh
#                               Non-interactive: pre-seeds credentials

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!! \033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mXX \033[0m %s\n' "$*" >&2; exit 1; }

say "JORAN Pocket installer"

# --- macOS-only sanity ---
[[ "$(uname -s)" == "Darwin" ]] || die "This installer only supports macOS (Darwin). Sorry."

# --- Homebrew ---
if ! command -v brew >/dev/null 2>&1; then
  die "Homebrew is required. Install it first: https://brew.sh"
fi

# --- Deps ---
missing=()
for b in tmux ttyd cloudflared; do
  command -v "$b" >/dev/null 2>&1 || missing+=("$b")
done

if [ ${#missing[@]} -gt 0 ]; then
  say "Missing dependencies: ${missing[*]}"
  printf '    Install now via brew? [Y/n] '
  read -r yn
  yn="${yn:-Y}"
  if [[ "$yn" =~ ^[Yy]$ ]]; then
    brew install "${missing[@]}"
  else
    die "Cannot continue without deps."
  fi
fi

# --- Password ---
POCKET_HOME="$HOME/Pocket"
AUTH_FILE="$POCKET_HOME/auth.txt"
mkdir -p "$POCKET_HOME"

if [ -s "$AUTH_FILE" ]; then
  say "Using existing credentials at $AUTH_FILE (edit that file + re-run to change)."
elif [ -n "${POCKET_USER:-}" ] && [ -n "${POCKET_PASS:-}" ]; then
  umask 077
  printf '%s:%s\n' "$POCKET_USER" "$POCKET_PASS" > "$AUTH_FILE"
  say "Saved credentials from env vars to $AUTH_FILE."
else
  say "Set a login password (any browser visiting the public URL will be asked for this)."
  printf '    Username [pocket]: '
  read -r u
  u="${u:-pocket}"
  while :; do
    printf '    Password: '
    stty -echo 2>/dev/null || true
    read -r p1
    stty echo 2>/dev/null || true
    printf '\n    Confirm : '
    stty -echo 2>/dev/null || true
    read -r p2
    stty echo 2>/dev/null || true
    printf '\n'
    if [ -z "$p1" ]; then warn "Empty password — try again."; continue; fi
    if [ "$p1" != "$p2" ]; then warn "Mismatch — try again."; continue; fi
    break
  done
  umask 077
  printf '%s:%s\n' "$u" "$p1" > "$AUTH_FILE"
  chmod 600 "$AUTH_FILE"
  say "Saved credentials to $AUTH_FILE (mode 600)."
fi

# --- Delegate to the real setup script ---
exec bash "$SCRIPT_DIR/scripts/setup-services.sh"
