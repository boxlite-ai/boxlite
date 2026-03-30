package main

import (
	"bufio"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"

	logrus "github.com/sirupsen/logrus"
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
// Optional upstreamTLSConfig overrides upstream TLS (nil = derive from hostname).
func handleWebSocketUpgrade(w http.ResponseWriter, req *http.Request, destAddr string, secrets []SecretConfig, upstreamTLSConfig ...*tls.Config) {
	// Substitute secrets in request headers
	substituteHeaders(req, secrets)

	hostname := req.Host
	if h, _, err := net.SplitHostPort(hostname); err == nil {
		hostname = h
	}

	// Dial upstream with TLS (wss://)
	rawConn, err := net.Dial("tcp", destAddr)
	if err != nil {
		logrus.WithError(err).WithField("destAddr", destAddr).Warn("websocket: upstream dial failed")
		http.Error(w, "upstream connection failed", http.StatusBadGateway)
		return
	}

	upstreamConn := tls.Client(rawConn, resolveUpstreamTLS(hostname, upstreamTLSConfig...))

	// Write the modified HTTP request to upstream
	err = req.Write(upstreamConn)
	if err != nil {
		upstreamConn.Close()
		logrus.WithError(err).Warn("websocket: upstream request write failed")
		http.Error(w, "upstream write failed", http.StatusBadGateway)
		return
	}

	// Read upstream response
	upstreamReader := bufio.NewReader(upstreamConn)
	upstreamResp, err := http.ReadResponse(upstreamReader, req)
	if err != nil {
		upstreamConn.Close()
		logrus.WithError(err).Warn("websocket: upstream response read failed")
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
		logrus.WithError(err).Warn("websocket: hijack failed")
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
	}()

	// guest -> upstream
	go func() {
		defer wg.Done()
		io.Copy(upstreamConn, guestConn)
	}()

	wg.Wait()
	// Both directions done — close both connections.
	// Don't use CloseWrite on tls.Conn (sends close_notify, not TCP half-close).
	guestConn.Close()
	upstreamConn.Close()
}
