package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

// safeWS wraps a gorilla websocket with a mutex so multiple goroutines
// (keepalive ticker, ICE candidate callback, main flow) can send frames
// without racing. gorilla's Conn is NOT safe for concurrent Write.
type safeWS struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (s *safeWS) WriteJSON(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return s.conn.WriteMessage(websocket.TextMessage, data)
}

func (s *safeWS) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn.Close()
}

// Pair drives one full pairing session:
//  - connect to signaling WSS
//  - wait for phone (guest) peer to arrive
//  - create RTCPeerConnection, DataChannel
//  - relay SDP + ICE via signaling
//  - after connected, bridge PTY bytes <-> data channel
//  - watch tmux for Claude states, push JSON on sidechannel DataChannel
func Pair(ctx context.Context, wssURL string, pty *tmuxPty, sessionName string) error {
	pctx, cancel := context.WithCancel(ctx)
	defer cancel()

	// Dial signaling WS.
	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
		// Same-site? No — any-origin Worker. Set Origin header.
		Subprotocols: []string{},
	}
	hdr := http.Header{}
	hdr.Set("User-Agent", "joran-pocket-helper/0.1")
	rawWS, _, err := dialer.DialContext(pctx, wssURL, hdr)
	if err != nil {
		return fmt.Errorf("dial signaling: %w", err)
	}
	ws := &safeWS{conn: rawWS}
	defer ws.Close()

	// Build PeerConnection with public STUN servers.
	pcCfg := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{URLs: []string{"stun:stun.l.google.com:19302"}},
			{URLs: []string{"stun:stun.cloudflare.com:3478"}},
		},
	}
	pc, err := webrtc.NewPeerConnection(pcCfg)
	if err != nil {
		return fmt.Errorf("new peer connection: %w", err)
	}
	defer pc.Close()

	// Build primary DataChannel for PTY bytes.
	ordered := true
	ptyDC, err := pc.CreateDataChannel("pty", &webrtc.DataChannelInit{
		Ordered: &ordered,
	})
	if err != nil {
		return fmt.Errorf("create pty DC: %w", err)
	}
	// Sidechannel for Claude-state JSON events.
	sideDC, err := pc.CreateDataChannel("sidechannel", &webrtc.DataChannelInit{
		Ordered: &ordered,
	})
	if err != nil {
		return fmt.Errorf("create sidechannel DC: %w", err)
	}

	// ---- ICE candidate trickle out to signaling ----
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		cand := c.ToJSON()
		msg := map[string]any{"type": "ice", "candidate": cand}
		_ = ws.WriteJSON(msg)
	})

	pc.OnICEConnectionStateChange(func(s webrtc.ICEConnectionState) {
		log.Printf("ICE state: %s", s.String())
	})
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		log.Printf("peer state: %s", s.String())
		// `disconnected` is a RECOVERABLE state — ICE momentarily lost path
		// (phone locking, Wi-Fi/cellular handoff, tab backgrounding for a
		// few seconds). WebRTC tries to re-establish and will transition
		// back to `connected`. Only declare the session truly dead on
		// `failed` or `closed`.
		if s == webrtc.PeerConnectionStateFailed ||
			s == webrtc.PeerConnectionStateClosed {
			cancel()
		}
	})

	// ---- DC: pty ↔ PTY (user's terminal) ----
	ptyConnected := make(chan struct{})
	var ptyConnOnce sync.Once
	ptyDC.OnOpen(func() {
		ptyConnOnce.Do(func() { close(ptyConnected) })
		log.Printf("pty DataChannel opened")
	})
	ptyDC.OnMessage(func(m webrtc.DataChannelMessage) {
		if m.IsString {
			var ctl struct {
				Type string `json:"type"`
				Cols uint16 `json:"cols"`
				Rows uint16 `json:"rows"`
				Data string `json:"data,omitempty"`
			}
			if err := json.Unmarshal(m.Data, &ctl); err != nil {
				return
			}
			switch ctl.Type {
			case "resize":
				// Helper-driven pane sizing (RunPaneSizeWatcher). Ignore.
			case "input":
				_, _ = pty.Write([]byte(ctl.Data))
			}
			return
		}
		_, _ = pty.Write(m.Data)
	})

	// ---- DC: sidechannel (Claude state + tmux windows + control) ----
	sideOpen := make(chan struct{})
	var sideOnce sync.Once
	sideDC.OnOpen(func() {
		sideOnce.Do(func() { close(sideOpen) })
		log.Printf("sideDC opened")
	})
	emitter := func(ev any) {
		b, err := json.Marshal(ev)
		if err != nil {
			return
		}
		_ = sideDC.SendText(string(b))
	}
	sideDC.OnMessage(func(m webrtc.DataChannelMessage) {
		if !m.IsString {
			return
		}
		var env struct {
			Type  string `json:"type"`
			Index int    `json:"index,omitempty"`
			Name  string `json:"name,omitempty"`
		}
		if err := json.Unmarshal(m.Data, &env); err != nil {
			return
		}
		switch env.Type {
		case "select_window":
			if err := SelectWindow(sessionName, env.Index); err != nil {
				log.Printf("select-window %d failed: %v", env.Index, err)
			}
		case "new_window":
			if err := NewWindow(sessionName); err != nil {
				log.Printf("new-window failed: %v", err)
			}
		case "kill_window":
			if err := KillWindow(sessionName, env.Index); err != nil {
				log.Printf("kill-window %d failed: %v", env.Index, err)
			}
		case "rename_window":
			if err := RenameWindow(sessionName, env.Index, env.Name); err != nil {
				log.Printf("rename-window %d failed: %v", env.Index, err)
			}
		}
	})

	// Pipe PTY bytes out to phone as soon as the pty DC is open.
	go func() {
		select {
		case <-ptyConnected:
		case <-pctx.Done():
			return
		}
		buf := make([]byte, 4096)
		for {
			n, err := pty.Read(buf)
			if n > 0 {
				if err := ptyDC.Send(buf[:n]); err != nil {
					log.Printf("pty DC send: %v", err)
					cancel()
					return
				}
			}
			if err != nil {
				if !errors.Is(err, io.EOF) && *flagVerbose {
					log.Printf("pty read: %v", err)
				}
				cancel()
				return
			}
		}
	}()

	// Spawn sidechannel watchers once the sidechannel is open.
	go func() {
		select {
		case <-sideOpen:
		case <-pctx.Done():
			return
		}
		go RunStateWatcher(pctx, sessionName, emitter)
		go RunWindowsWatcher(pctx, sessionName, emitter)
		go RunPaneSizeWatcher(pctx, sessionName, pty, emitter)
	}()

	// ---- Signaling loop ----
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return fmt.Errorf("create offer: %w", err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		return fmt.Errorf("set local desc: %w", err)
	}

	// Wait until we see "peer-joined guest" before sending the offer, so the
	// Worker has a target to relay to.
	waitForGuest := make(chan struct{})
	doneSignal := make(chan struct{})

	go func() {
		defer close(doneSignal)
		for {
			ws.conn.SetReadDeadline(time.Now().Add(5 * time.Minute))
			_, raw, err := ws.conn.ReadMessage()
			if err != nil {
				if pctx.Err() == nil {
					log.Printf("signaling read: %v", err)
					// If we lose signaling before the PC is up, there's
					// no way to recover this Pair — cancel so the main
					// loop re-registers with a fresh WS instead of
					// hanging forever on <-pctx.Done().
					cancel()
				}
				return
			}
			var env struct {
				Type      string          `json:"type"`
				SDP       string          `json:"sdp,omitempty"`
				Role      string          `json:"role,omitempty"`
				Candidate json.RawMessage `json:"candidate,omitempty"`
			}
			if err := json.Unmarshal(raw, &env); err != nil {
				continue
			}
			switch env.Type {
			case "hello":
				log.Printf("signaling: role=%s", env.Role)
			case "peer-joined":
				if env.Role == "guest" {
					select {
					case waitForGuest <- struct{}{}:
					default:
					}
				}
			case "peer-left":
				if env.Role == "guest" {
					cancel()
					return
				}
			case "answer":
				ans := webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: env.SDP}
				if err := pc.SetRemoteDescription(ans); err != nil {
					log.Printf("set remote answer: %v", err)
				}
			case "ice":
				var c webrtc.ICECandidateInit
				if err := json.Unmarshal(env.Candidate, &c); err == nil {
					if err := pc.AddICECandidate(c); err != nil && *flagVerbose {
						log.Printf("add ice: %v", err)
					}
				}
			case "done":
				cancel()
				return
			}
		}
	}()

	// Keepalive: signaling Worker's DO garbage-collects idle sessions, so we
	// ping every 25s while waiting / during the call. Ping/pong messages bump
	// lastSeen on the server side.
	keepalive := time.NewTicker(25 * time.Second)
	defer keepalive.Stop()
	keepaliveDone := make(chan struct{})
	go func() {
		defer close(keepaliveDone)
		for {
			select {
			case <-pctx.Done():
				return
			case <-keepalive.C:
				_ = ws.WriteJSON(map[string]any{"type": "ping"})
			}
		}
	}()

	// When guest is there, ship offer.
	select {
	case <-waitForGuest:
		_ = ws.WriteJSON(map[string]any{"type": "offer", "sdp": offer.SDP})
	case <-pctx.Done():
		<-keepaliveDone
		return pctx.Err()
	case <-time.After(60 * time.Minute):
		return fmt.Errorf("no phone joined within 1 hour")
	}

	// Wait for the session to end (either PC failure or signaling close).
	<-pctx.Done()
	_ = ws.WriteJSON(map[string]any{"type": "done"})
	<-doneSignal // let the reader exit cleanly
	return nil
}
