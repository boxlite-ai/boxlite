package main

import (
	"bufio"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
)

// isWebSocketUpgrade checks if the request is a WebSocket upgrade.
func isWebSocketUpgrade(req *http.Request) bool {
	// Check Connection header contains "upgrade" token (case-insensitive, may be comma-separated)
	connHeader := req.Header.Get("Connection")
	hasUpgrade := false
	for _, token := range strings.Split(connHeader, ",") {
		if strings.EqualFold(strings.TrimSpace(token), "upgrade") {
			hasUpgrade = true
			break
		}
	}
	if !hasUpgrade {
		return false
	}
	// Check Upgrade header is "websocket" (case-insensitive)
	upgrade := req.Header.Get("Upgrade")
	return strings.EqualFold(upgrade, "websocket")
}

// handleWebSocketUpgrade handles a WebSocket upgrade through the MITM proxy.
func handleWebSocketUpgrade(w http.ResponseWriter, req *http.Request, destAddr string, secrets []SecretConfig) {
	// Substitute secrets in request headers
	substituteHeaders(req, secrets)

	// Dial upstream
	upstreamConn, err := net.Dial("tcp", destAddr)
	if err != nil {
		log.Printf("websocket: failed to dial upstream %s: %v", destAddr, err)
		http.Error(w, "upstream connection failed", http.StatusBadGateway)
		return
	}

	// Write the modified HTTP request to upstream (plain TCP, no TLS for test upstream)
	err = req.Write(upstreamConn)
	if err != nil {
		upstreamConn.Close()
		log.Printf("websocket: failed to write request to upstream: %v", err)
		http.Error(w, "upstream write failed", http.StatusBadGateway)
		return
	}

	// Read upstream response
	upstreamReader := bufio.NewReader(upstreamConn)
	upstreamResp, err := http.ReadResponse(upstreamReader, req)
	if err != nil {
		upstreamConn.Close()
		log.Printf("websocket: failed to read upstream response: %v", err)
		http.Error(w, "upstream response failed", http.StatusBadGateway)
		return
	}

	// Hijack the guest connection
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		upstreamConn.Close()
		upstreamResp.Body.Close()
		http.Error(w, "hijack not supported", http.StatusInternalServerError)
		return
	}

	guestConn, guestBuf, err := hijacker.Hijack()
	if err != nil {
		upstreamConn.Close()
		upstreamResp.Body.Close()
		log.Printf("websocket: hijack failed: %v", err)
		return
	}

	// Write the upstream 101 response back to the guest
	err = upstreamResp.Write(guestBuf)
	if err != nil {
		guestConn.Close()
		upstreamConn.Close()
		return
	}
	guestBuf.Flush()

	// Bidirectional relay
	var wg sync.WaitGroup
	wg.Add(2)

	// upstream -> guest
	go func() {
		defer wg.Done()
		io.Copy(guestConn, upstreamReader)
		// Signal guest that upstream is done writing
		if tc, ok := guestConn.(*net.TCPConn); ok {
			tc.CloseWrite()
		}
	}()

	// guest -> upstream
	go func() {
		defer wg.Done()
		io.Copy(upstreamConn, guestConn)
		// Signal upstream that guest is done writing
		if tc, ok := upstreamConn.(*net.TCPConn); ok {
			tc.CloseWrite()
		}
	}()

	wg.Wait()
	guestConn.Close()
	upstreamConn.Close()
}
