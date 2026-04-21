// JORAN Pocket — Mac helper.
//
// Usage: pocket
//
// What it does:
//   1. Starts (or attaches to) tmux session 'pocket'
//   2. POSTs /register on the signaling Worker, gets a 6-char code
//   3. Prints the code (+ phone URL + QR) to stdout so you can scan
//   4. Opens a WebSocket to the signaling Worker, waits for the phone to join
//   5. Establishes a WebRTC PeerConnection (DTLS-encrypted DataChannel)
//   6. Relays PTY bytes <-> DataChannel bytes (main stream)
//   7. Watches tmux pane content for Claude Code states; pushes JSON events
//      on a second DataChannel ("sidechannel")
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
	"os/signal"
	"strings"
	"syscall"
)

const defaultSignalingHost = "joran-pocket-signaling.<your-subdomain>.workers.dev"

var (
	flagSignaling = flag.String("signaling", envOr("POCKET_SIGNALING", defaultSignalingHost),
		"Signaling host (https://...) or bare hostname (workers.dev auto-https). "+
			"Override with POCKET_SIGNALING env or --signaling flag.")
	flagTmuxSession = flag.String("session", envOr("POCKET_SESSION", "pocket"),
		"tmux session name to attach/create.")
	flagPair = flag.String("pair", "", "Existing pairing code to reuse (skips /register).")
	flagOnce = flag.Bool("once", false, "Exit after the first phone session ends.")
	flagVerbose = flag.Bool("v", false, "Verbose logs.")
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
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
	if strings.Contains(signalingHTTP, "<your-subdomain>") {
		log.Fatalf("please set POCKET_SIGNALING or --signaling to your Cloudflare Worker URL")
	}

	// 1) Obtain a pairing code.
	code, wssURL, err := registerOrReuse(ctx, signalingHTTP, *flagPair)
	if err != nil {
		log.Fatalf("register: %v", err)
	}
	printPairing(code, signalingHTTP)

	// 2) Attach/create tmux session and open its PTY.
	pty, err := openTmuxPty(ctx, *flagTmuxSession)
	if err != nil {
		log.Fatalf("tmux: %v", err)
	}
	defer pty.Close()

	// 3) Run the pairing + WebRTC + PTY-bridge loop.
	run := func() error {
		return Pair(ctx, wssURL, pty, *flagTmuxSession)
	}

	for {
		if err := run(); err != nil && ctx.Err() == nil {
			log.Printf("session ended with error: %v", err)
		}
		if *flagOnce || ctx.Err() != nil {
			return
		}
		// New pairing code for next round.
		code, wssURL, err = registerOrReuse(ctx, signalingHTTP, "")
		if err != nil {
			log.Printf("re-register failed, retry in 5s: %v", err)
			select {
			case <-ctx.Done():
				return
			default:
			}
			continue
		}
		printPairing(code, signalingHTTP)
	}
}

func normalizeSignalingURL(s string) string {
	s = strings.TrimRight(s, "/")
	if strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://") {
		return s
	}
	return "https://" + s
}

func printPairing(code, signaling string) {
	u, _ := url.Parse(signaling)
	// PWA host is a sibling convention: pwa.<domain>, or configurable.
	pwaHost := envOr("POCKET_PWA_URL", "https://joran-pocket.pages.dev")
	fmt.Printf("\n")
	fmt.Printf("   📱  配对码：\033[1;33m%s\033[0m\n", code)
	fmt.Printf("   🔗  或打开：%s/p/%s\n", pwaHost, code)
	fmt.Printf("   ⏱   5 分钟内在手机端 Safari 打开\n")
	fmt.Printf("   🔐  信令：%s\n", u.Host)
	fmt.Printf("\n")
	_ = code
}
