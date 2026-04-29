// JORAN Pocket — Mac helper.
//
// Usage:
//   pocket            Run helper in the foreground (Ctrl-C to stop).
//   pocket install    Install LaunchAgent so helper starts at login.
//   pocket uninstall  Remove the LaunchAgent.
//   pocket attach     Activate helper + attach this Terminal window to the
//                     shared 'pocket' tmux session. Pushes the fresh
//                     pairing URL to your phone via iMessage.
//   pocket sleep      Deactivate helper (invalidates the link). Helper
//                     stays running but disconnects from Cloudflare.
//   pocket url        Print the current pairing URL (only valid while
//                     helper is in active state).
//   pocket status     Print LaunchAgent / helper state.
//
// State model:
//   IDLE    Helper is alive but holds no signaling connection. The
//           Cloudflare DO has nothing reachable. Phone can't connect.
//           No iMessage was sent. caffeinate is off.
//   ACTIVE  Helper has registered a fresh code with the signaling Worker,
//           written url.txt, iMessaged the link, started caffeinate, and
//           is running the Pair loop. Transitions are gated on the
//           on-disk marker ~/.pocket/active so `pocket attach` /
//           `pocket sleep` are decoupled from helper lifecycle.
//
// On boot the helper deletes the marker and any stale url.txt, so the
// link is never live until the user explicitly opts in by running
// `pocket attach` after login.
//
// No terminal bytes ever pass through the signaling server.

package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

const (
	defaultSignalingHost = "joran-pocket.pages.dev"
	defaultPWAHost       = "https://joran-pocket.pages.dev"
)

var (
	flagSignaling = flag.String("signaling", envOr("POCKET_SIGNALING", defaultSignalingHost),
		"Signaling host (https://...) or bare hostname (auto-https). "+
			"Override with POCKET_SIGNALING env or --signaling flag.")
	flagTmuxSession = flag.String("session", envOr("POCKET_SESSION", "pocket"),
		"tmux session name to attach/create.")
	flagPair    = flag.String("pair", "", "Existing pairing code to reuse (skips /register).")
	flagOnce    = flag.Bool("once", false, "Exit after the first phone session ends.")
	flagVerbose = flag.Bool("v", false, "Verbose logs.")
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	// Subcommand dispatch: if first non-flag arg is a known command, handle
	// it directly without starting the WebRTC helper.
	if len(os.Args) > 1 && !strings.HasPrefix(os.Args[1], "-") {
		switch os.Args[1] {
		case "attach":
			attachSelf()
			return
		case "install":
			runInstall()
			return
		case "uninstall":
			runUninstall()
			return
		case "url":
			runURL()
			return
		case "status":
			runStatus()
			return
		case "sleep":
			runSleep()
			return
		case "help", "--help", "-h":
			flag.Usage()
			fmt.Println("\nSubcommands:")
			fmt.Println("  install    Install LaunchAgent so helper starts at login")
			fmt.Println("  uninstall  Remove the LaunchAgent")
			fmt.Println("  attach     Activate helper + attach this Terminal to the pocket session")
			fmt.Println("  sleep      Deactivate helper (invalidates the link)")
			fmt.Println("  url        Print current pairing URL (only when active)")
			fmt.Println("  status     Show helper / LaunchAgent state")
			return
		}
	}

	flag.Parse()
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Graceful shutdown on Ctrl-C / SIGTERM.
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sig
		fmt.Fprintln(os.Stderr, "\n→ shutting down…")
		cancel()
	}()

	signalingHTTP := normalizeSignalingURL(*flagSignaling)
	pwaHost := strings.TrimRight(envOr("POCKET_PWA_URL", defaultPWAHost), "/")

	// Boot reset — link is never live until the user opts in via
	// `pocket attach`, even if a previous active session left state on disk.
	_ = clearActive()
	_ = os.Remove(urlFilePath())
	_ = os.Remove(codeFilePath())

	// Open the tmux PTY once at boot. Held across idle/active transitions
	// so the tmux session keeps existing even when no link is published.
	pty, err := openTmuxPty(ctx, *flagTmuxSession)
	if err != nil {
		log.Fatalf("tmux: %v", err)
	}
	defer pty.Close()

	log.Printf("helper started in IDLE — run `pocket attach` to publish the link")

	for !*flagOnce && ctx.Err() == nil {
		// ── IDLE: wait for `pocket attach` to drop the active marker ──
		if !waitForActive(ctx) {
			return
		}
		log.Printf("ACTIVE — registering with signaling")

		// Sub-context tied to the active state. Cancelled on
		//   • parent ctx done (ctrl-c / SIGTERM)
		//   • active marker removed (`pocket sleep`)
		actCtx, actCancel := context.WithCancel(ctx)
		startCaffeinate(actCtx)
		watchActiveMarker(actCtx, actCancel)

		runActiveSession(actCtx, signalingHTTP, pwaHost, pty, *flagTmuxSession)
		actCancel()

		// Tear down state so the next idle-state inspection can't expose
		// a now-dead URL or stale code to anyone.
		_ = os.Remove(urlFilePath())
		_ = os.Remove(codeFilePath())
		log.Printf("IDLE — link invalidated; run `pocket attach` to re-publish")
	}
}

// waitForActive polls for the on-disk active marker. Returns true when it
// shows up, false if ctx is cancelled first. Polling at 250 ms keeps the
// `pocket attach` → "URL ready" latency well under a second.
func waitForActive(ctx context.Context) bool {
	if isActive() {
		return true
	}
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return false
		case <-tick.C:
			if isActive() {
				return true
			}
		}
	}
}

// watchActiveMarker cancels the active sub-context when the marker is
// removed (`pocket sleep`). Coarser polling than waitForActive — once
// active, we don't expect frequent transitions.
func watchActiveMarker(ctx context.Context, cancel context.CancelFunc) {
	go func() {
		tick := time.NewTicker(2 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				if !isActive() {
					log.Printf("active marker removed — deactivating")
					cancel()
					return
				}
			}
		}
	}()
}

// runActiveSession holds the signaling connection and the Pair loop.
// Returns when ctx is cancelled. Code handling:
//   - On entry: always mint a FRESH code (old codes are abandoned along
//     with their Cloudflare DOs whenever the active marker drops).
//   - During the session: reuse the sticky code on phone re-handshake.
//   - On repeated fast-fail (DO wedged on Cloudflare's side): rotate.
func runActiveSession(ctx context.Context, signalingHTTP, pwaHost string, pty *tmuxPty, sessionName string) {
	code, wssURL, err := registerOrReuse(ctx, signalingHTTP, "")
	if err != nil {
		log.Printf("initial register failed: %v", err)
		return
	}
	stickyCode := code
	_ = writePersistedCode(stickyCode)
	_ = writeURLFile(pwaHost, stickyCode)
	// shouldIMessage=true on entry — the user just ran `pocket attach`
	// and is expecting the link to land on their phone right now.
	printPairing(code, signalingHTTP, pwaHost, true)

	const minBackoff = 1 * time.Second
	const maxBackoff = 30 * time.Second
	const stuckThreshold = 5

	backoff := time.Duration(0)
	consecutiveFastFails := 0

	for ctx.Err() == nil {
		startedAt := time.Now()
		err := Pair(ctx, wssURL, pty, sessionName)
		if err != nil && ctx.Err() == nil {
			log.Printf("session ended: %v", err)
		}
		if ctx.Err() != nil {
			return
		}
		if time.Since(startedAt) < 2*time.Second {
			consecutiveFastFails++
			if backoff == 0 {
				backoff = minBackoff
			} else {
				backoff *= 2
				if backoff > maxBackoff {
					backoff = maxBackoff
				}
			}
		} else {
			consecutiveFastFails = 0
			backoff = 0
		}

		if consecutiveFastFails >= stuckThreshold {
			log.Printf("sticky code %s appears wedged after %d fast fails; rotating",
				stickyCode, consecutiveFastFails)
			_ = os.Remove(codeFilePath())
			_ = os.Remove(urlFilePath())
			newCode, newWss, regErr := registerOrReuse(ctx, signalingHTTP, "")
			if regErr == nil {
				stickyCode = newCode
				code = newCode
				wssURL = newWss
				prevURL := readURLFile()
				newURL := fmt.Sprintf("%s/p/%s", pwaHost, stickyCode)
				_ = writePersistedCode(stickyCode)
				_ = writeURLFile(pwaHost, stickyCode)
				printPairing(code, signalingHTTP, pwaHost, prevURL != newURL)
				consecutiveFastFails = 0
				backoff = 0
				continue
			}
			log.Printf("rotation failed: %v", regErr)
		}

		_ = pty.Resize(42, 20)

		if backoff > 0 {
			log.Printf("re-attaching with code %s in %s (fast-fail #%d)",
				stickyCode, backoff, consecutiveFastFails)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
		} else {
			log.Printf("re-attaching with same code %s", stickyCode)
		}

		code, wssURL, err = registerOrReuse(ctx, signalingHTTP, stickyCode)
		if err != nil {
			log.Printf("re-register failed, retry in 5s: %v", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(5 * time.Second):
			}
			continue
		}
	}
}

func normalizeSignalingURL(s string) string {
	s = strings.TrimRight(s, "/")
	if strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://") {
		return s
	}
	return "https://" + s
}

// attachSelf: called when user runs `pocket attach` in Terminal.app.
//
// Flow:
//  1. Drop the active marker so the helper transitions IDLE → ACTIVE.
//  2. Ensure helper is running (LaunchAgent or fork).
//  3. Create / extend the tmux session (new-window for fresh cwd).
//  4. Wait for url.txt — that's helper's "I just registered + iMessaged"
//     signal. The iMessage itself is sent from helper's printPairing,
//     not from this process, so there's exactly one push per activation.
//  5. Force tmux to redraw the pane to all clients so the phone xterm
//     sees the post-attach state immediately, instead of waiting for the
//     next pane_size poll + organic stdout to fill the new geometry.
//  6. exec tmux attach-session so this Terminal window becomes a live
//     view on the shared session.
func attachSelf() {
	session := envOr("POCKET_SESSION", "pocket")
	_ = WriteTmuxConf()

	// 1) Activate. Helper polls this marker and transitions to ACTIVE,
	//    minting a fresh code + writing url.txt + iMessaging.
	if err := setActive(); err != nil {
		fmt.Fprintf(os.Stderr, "warn: setActive: %v\n", err)
	}

	// 2) Make sure the helper process is alive. setActive on its own is
	//    only meaningful if there's a helper polling the file.
	ensureHelperRunning()

	// 3) Preserve user's cwd for the new window's shell.
	cwd, err := os.Getwd()
	if err != nil || cwd == "" {
		cwd, _ = os.UserHomeDir()
	}

	has := exec.Command("tmux", "-L", pocketSocket, "has-session", "-t", session)
	if err := has.Run(); err != nil {
		create := exec.Command("tmux", "-L", pocketSocket, "-f", tmuxConfPath(),
			"new-session", "-d", "-s", session, "-c", cwd)
		create.Env = append(tmuxEnv(), "TERM=xterm-256color")
		if out, err := create.CombinedOutput(); err != nil {
			fmt.Fprintf(os.Stderr, "tmux new-session: %v: %s\n", err, string(out))
			os.Exit(1)
		}
	} else {
		nw := exec.Command("tmux", "-L", pocketSocket, "new-window", "-t", session, "-c", cwd)
		nw.Env = append(tmuxEnv(), "TERM=xterm-256color")
		if out, err := nw.CombinedOutput(); err != nil {
			fmt.Fprintf(os.Stderr, "tmux new-window: %v: %s\n", err, string(out))
			os.Exit(1)
		}
	}

	// 4) Wait for url.txt to appear (helper just transitioned to ACTIVE
	//    and is calling registerOrReuse). 15-second budget covers the
	//    Cloudflare round trip even on slow networks.
	deadline := time.Now().Add(15 * time.Second)
	var urlReady string
	for time.Now().Before(deadline) {
		if u := readURLFile(); u != "" {
			urlReady = u
			break
		}
		time.Sleep(150 * time.Millisecond)
	}
	if urlReady != "" {
		if to := iMessageRecipient(); to != "" {
			fmt.Printf("\n   📤  已 iMessage 推送链接到 %s\n   🔗  %s\n\n", to, urlReady)
		} else {
			fmt.Printf("\n   🔗  手机打开：%s\n\n", urlReady)
		}
	} else {
		fmt.Fprintln(os.Stderr, "\n   (⚠ 15 秒内 helper 没写入 URL — 检查 ~/.pocket/helper.err)")
	}

	// 5) Nudge tmux to repaint the pane to every attached client (helper
	//    PTY included). Without this, the phone's xterm shows whatever
	//    the pane looked like at the small idle size until the next bit
	//    of organic stdout fills the new geometry — that's the "have to
	//    swipe to see content" symptom.
	rc := exec.Command("tmux", "-L", pocketSocket, "refresh-client")
	rc.Env = tmuxEnv()
	_ = rc.Run()

	// 6) Hand the Terminal window over to tmux.
	tmuxBin, err := exec.LookPath("tmux")
	if err != nil {
		fmt.Fprintln(os.Stderr, "tmux not found in PATH")
		os.Exit(1)
	}
	if err := syscall.Exec(tmuxBin, []string{"tmux", "-L", pocketSocket, "attach-session", "-t", session}, os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "exec tmux attach: %v\n", err)
		os.Exit(1)
	}
}

// ensureHelperRunning starts the helper if it isn't already alive. Uses
// launchctl kickstart when a LaunchAgent is installed; otherwise forks
// the helper as a detached child. Waits up to ~10s for url.txt to show
// up, which is our signal that helper reached the Pair loop.
func ensureHelperRunning() {
	if helperRunning() {
		return
	}
	started := false
	if launchAgentInstalled() {
		if err := kickstartHelper(); err == nil {
			started = true
			fmt.Println("   🚀  helper 已通过 LaunchAgent 启动")
		} else {
			fmt.Fprintf(os.Stderr, "   (LaunchAgent kickstart 失败: %v — 回退到 fork)\n", err)
		}
	}
	if !started {
		self, err := os.Executable()
		if err != nil {
			fmt.Fprintf(os.Stderr, "   无法获取 helper 路径: %v\n", err)
			return
		}
		cmd := exec.Command(self)
		cmd.Env = os.Environ()
		// Detach: new session so it survives this process exiting.
		cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		// Redirect IO so it doesn't capture our stdin/out/err.
		logPath := pocketDir() + "/helper.log"
		if f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
			cmd.Stdout = f
			cmd.Stderr = f
		}
		cmd.Stdin = nil
		if err := cmd.Start(); err != nil {
			fmt.Fprintf(os.Stderr, "   启动 helper 失败: %v\n", err)
			return
		}
		fmt.Println("   🚀  helper 已后台启动（建议 `pocket install` 让它开机自启）")
	}
	// Wait up to 10s for url.txt to appear / update. Poll every 250ms.
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if readURLFile() != "" && helperRunning() {
			return
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func printPairing(code, signaling, pwaHost string, shouldIMessage bool) {
	u, _ := url.Parse(signaling)
	urlStr := fmt.Sprintf("%s/p/%s", pwaHost, code)
	fmt.Printf("\n")
	fmt.Printf("   📱  配对码：\033[1;33m%s\033[0m\n", code)
	fmt.Printf("   🔗  或打开：%s\n", urlStr)
	fmt.Printf("   ⏱   永久有效（URL 在 helper 重启间也保持不变）\n")
	fmt.Printf("   🔐  信令：%s\n", u.Host)
	if shouldIMessage {
		if to := iMessageRecipient(); to != "" {
			SendIMessage(to, fmt.Sprintf("🌍 JORAN Pocket 链接：%s", urlStr))
			fmt.Printf("   📤  已 iMessage 推送到 %s\n", to)
		}
	}
	fmt.Printf("\n")
}

// ----- Subcommand handlers ----------------------------------------------

func runInstall() {
	signalingURL := normalizeSignalingURL(envOr("POCKET_SIGNALING", defaultSignalingHost))
	pwaURL := strings.TrimRight(envOr("POCKET_PWA_URL", defaultPWAHost), "/")
	if err := installLaunchAgent(signalingURL, pwaURL); err != nil {
		log.Fatalf("install: %v", err)
	}
	fmt.Println("✓ LaunchAgent 已安装并启动")
	fmt.Println("  • helper 会在登录后自动启动，崩溃后自动重启")
	fmt.Println("  • caffeinate 子进程会阻止 Mac 睡眠/进屏保（只在 helper 运行时）")
	fmt.Printf("  • 日志：%s/helper.log, %s/helper.err\n", pocketDir(), pocketDir())
	fmt.Println("  • 停止：pocket uninstall")
	fmt.Println()
	// Wait for URL to appear so user can see what link they have.
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if u := readURLFile(); u != "" {
			fmt.Printf("  🔗  当前链接：%s\n\n", u)
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
	fmt.Println("  (URL 尚未生成 — 稍等一会儿后运行 `pocket url` 查看)")
}

func runUninstall() {
	if err := uninstallLaunchAgent(); err != nil {
		log.Fatalf("uninstall: %v", err)
	}
	fmt.Println("✓ LaunchAgent 已卸载（helper 已停止）")
}

func runURL() {
	u := readURLFile()
	if u == "" {
		fmt.Fprintln(os.Stderr, "(没有 URL — helper 当前 IDLE，运行 `pocket attach` 激活)")
		os.Exit(1)
	}
	fmt.Println(u)
}

func runSleep() {
	if err := clearActive(); err != nil {
		log.Fatalf("sleep: %v", err)
	}
	fmt.Println("✓ helper 已进入 idle，链接已失效")
	fmt.Println("  下次 `pocket attach` 会自动重新激活并推送新链接")
}

func runStatus() {
	fmt.Printf("LaunchAgent: ")
	if launchAgentInstalled() {
		fmt.Printf("installed (%s)\n", launchAgentPath())
	} else {
		fmt.Println("not installed")
	}
	fmt.Printf("helper 进程: ")
	if helperRunning() {
		fmt.Println("running")
	} else {
		fmt.Println("stopped")
	}
	fmt.Printf("状态: ")
	switch {
	case isActive() && readURLFile() != "":
		fmt.Println("ACTIVE — 链接已发布")
	case isActive():
		fmt.Println("ACTIVATING — 等待 helper 注册")
	default:
		fmt.Println("IDLE — 跑 `pocket attach` 激活")
	}
	fmt.Printf("当前 URL: ")
	if u := readURLFile(); u != "" {
		fmt.Println(u)
	} else {
		fmt.Println("(none)")
	}
}
