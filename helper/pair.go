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
	ws, _, err := dialer.DialContext(pctx, wssURL, hdr)
	if err != nil {
		return fmt.Errorf("dial signaling: %w", err)
	}
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
		sendJSON(ws, msg)
	})

	pc.OnICEConnectionStateChange(func(s webrtc.ICEConnectionState) {
		if *flagVerbose {
			log.Printf("ICE state: %s", s.String())
		}
	})
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		log.Printf("peer state: %s", s.String())
		if s == webrtc.PeerConnectionStateFailed ||
			s == webrtc.PeerConnectionStateClosed ||
			s == webrtc.PeerConnectionStateDisconnected {
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
		// Phone -> Mac: user keystrokes or resize.
		if m.IsString {
			// Control JSON frames come as text; data as binary.
			var ctl struct {
				Type    string `json:"type"`
				Cols    uint16 `json:"cols"`
				Rows    uint16 `json:"rows"`
				Data    string `json:"data,omitempty"`
			}
			if err := json.Unmarshal(m.Data, &ctl); err != nil {
				return
			}
			switch ctl.Type {
			case "resize":
				_ = pty.Resize(ctl.Cols, ctl.Rows)
			case "input":
				_, _ = pty.Write([]byte(ctl.Data))
			}
			return
		}
		_, _ = pty.Write(m.Data)
	})

	// Start piping PTY bytes out to the phone as soon as the DC opens.
	go func() {
		<-ptyConnected
		buf := make([]byte, 4096)
		for {
			n, err := pty.Read(buf)
			if n > 0 {
				// Respect DC buffered-amount thresholds to avoid OOM on the other side.
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

	// ---- DC: sidechannel (Claude state events) ----
	sideOpen := make(chan struct{})
	var sideOnce sync.Once
	sideDC.OnOpen(func() { sideOnce.Do(func() { close(sideOpen) }) })

	go func() {
		select {
		case <-sideOpen:
		case <-pctx.Done():
			return
		}
		RunStateWatcher(pctx, sessionName, func(ev ClaudeEvent) {
			b, err := json.Marshal(ev)
			if err != nil {
				return
			}
			_ = sideDC.SendText(string(b))
		})
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
			ws.SetReadDeadline(time.Now().Add(5 * time.Minute))
			_, raw, err := ws.ReadMessage()
			if err != nil {
				if pctx.Err() == nil {
					log.Printf("signaling read: %v", err)
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

	// When guest is there, ship offer.
	select {
	case <-waitForGuest:
		sendJSON(ws, map[string]any{"type": "offer", "sdp": offer.SDP})
	case <-pctx.Done():
		return pctx.Err()
	case <-time.After(5 * time.Minute):
		return fmt.Errorf("no phone joined within 5 minutes")
	}

	// Wait for the session to end (either PC failure or signaling close).
	<-pctx.Done()
	sendJSON(ws, map[string]any{"type": "done"})
	<-doneSignal // let the reader exit cleanly
	return nil
}

func sendJSON(ws *websocket.Conn, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_ = ws.WriteMessage(websocket.TextMessage, data)
}
