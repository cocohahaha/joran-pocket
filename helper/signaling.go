package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type registerResp struct {
	Code       string `json:"code"`
	WSS        string `json:"wss"`
	ExpiresInS int    `json:"expires_in_s"`
}

// registerOrReuse calls POST /register on the signaling service; or if the
// user passed an existing code via --pair, it just builds the WSS URL.
func registerOrReuse(ctx context.Context, signalingHTTP, existingCode string) (code, wssURL string, err error) {
	if existingCode != "" {
		host := strings.TrimPrefix(strings.TrimPrefix(signalingHTTP, "https://"), "http://")
		scheme := "wss"
		if strings.HasPrefix(signalingHTTP, "http://") {
			scheme = "ws"
		}
		return existingCode, fmt.Sprintf("%s://%s/api/pair/%s/ws?role=host", scheme, host, existingCode), nil
	}

	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(cctx, http.MethodPost, signalingHTTP+"/api/register", nil)
	if err != nil {
		return "", "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return "", "", fmt.Errorf("signaling /register returned %d: %s", resp.StatusCode, string(body))
	}

	var r registerResp
	if err := json.Unmarshal(body, &r); err != nil {
		return "", "", fmt.Errorf("decode /register body: %w", err)
	}
	if r.Code == "" || r.WSS == "" {
		return "", "", fmt.Errorf("signaling returned incomplete response: %s", string(body))
	}
	// Append role=host so the Worker routes us to the host slot deterministically.
	sep := "?"
	if strings.Contains(r.WSS, "?") {
		sep = "&"
	}
	return r.Code, r.WSS + sep + "role=host", nil
}
