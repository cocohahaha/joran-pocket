---
name: pocket
description: Start, check, or rotate the JORAN Pocket phone-to-Mac remote terminal. Use when the user mentions "JORAN Pocket", "joran pocket", "pocket", "口袋", "启动口袋", "打开口袋", "远程终端", "手机远程", "tunnel URL", "trycloudflare", "我要在手机上开终端", "给我 URL", "把链接发到手机", or otherwise wants to obtain / refresh / stop the Cloudflare Quick Tunnel that exposes their Mac's tmux session to their iPhone.
---

# JORAN Pocket — phone remote terminal control

The user has a `pocket` CLI (at `/opt/homebrew/bin/pocket`, symlinked to `~/Pocket/bin/pocket`) managing a tmux + ttyd + Cloudflare Quick Tunnel stack via launchd. Public URLs are gated by HTTP Basic Auth (credentials in `~/Pocket/auth.txt`).

## Default behavior (run BOTH steps, in order)

**Step 1 — ensure services + get URL:**

```bash
pocket
```

This ensures three launchd services (`pocket.tmux.ttyd`, `pocket.tmux.tunnel`, `pocket.tmux.watcher`) are up, prints the public `https://*.trycloudflare.com` URL, copies it to the clipboard, and (if `~/Pocket/imessage-to.txt` is configured) iMessages it to the recipient.

**Step 2 — spawn a new Terminal.app window attached to the shared tmux session:**

```bash
osascript -e 'tell application "Terminal" to do script "pocket attach"' \
          -e 'tell application "Terminal" to activate' >/dev/null
```

A fresh Terminal.app window opens running `pocket attach`, mirroring the phone's view live. The user's current Claude window is untouched. **Always run Step 2 unless the user says "不要新开窗口" / "skip attach" / similar.**

**Report to the user:**
1. URL on its own line with 🌍 prefix.
2. Confirm `clipboard ✓ / iMessage ✓ / new Terminal window ✓`.
3. Mention login: `username: <from ~/Pocket/auth.txt>` (don't print the password).

## Intent-to-subcommand mapping

| If user says... | Run |
|---|---|
| "启动" / "开一下" / "给我 URL" / "连手机" | `pocket` (default) |
| "换个 URL" / "新链接" / "URL 失效了" / "重启隧道" | `pocket restart` |
| "停了吧" / "关掉" / "别让别人能连" | `pocket stop` |
| "看看状态" / "还活着吗" / "status" | `pocket status` |
| "日志" / "为什么连不上" / "debug" | `pocket logs` (tail — Ctrl-C to quit) |
| "重装" / "我改了配置" / "reinstall" | `pocket install` |

## Why a new Terminal window (not the current one)

Claude Code occupies the user's current terminal PTY, so Claude cannot attach that terminal to the `pocket` tmux session (it would replace Claude's own PTY and kill this conversation). The skill's default — auto-spawn a new Terminal.app window — is the correct substitute.

## Safety rules

- **Never** run `pocket stop` or `pocket restart` unprompted. URL rotation breaks the phone bookmark.
- If `pocket` exits non-zero or times out, show last 30 lines of `pocket logs` and ask before corrective action.
- The Quick Tunnel URL is public, but gated by basic auth. If the user mentions sharing the URL or screencasting, remind them the password is the only barrier.

## Output contract

End every successful response with the URL on its own line:

```
🌍  https://xyz-xyz-xyz.trycloudflare.com
```

So it's copy-pasteable from the chat.
