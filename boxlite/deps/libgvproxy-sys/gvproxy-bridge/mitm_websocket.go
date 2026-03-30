package main

import (
	"bufio"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"strings"

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
//
// Limitation: only request headers are substituted. WebSocket message frames
// are relayed verbatim — placeholders in message bodies are NOT substituted.
// This is by design: WebSocket is a streaming protocol and frames may be
// fragmented arbitrarily, making reliable substitution impractical.
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

	// Bidirectional relay. When one direction finishes (EOF or error),
	// close both connections to unblock the other io.Copy. Without this,
	// a hanging upstream would block the goroutine forever.
	done := make(chan struct{}, 2)

	go func() {
		io.Copy(guestConn, upstreamReader)
		guestConn.Close()
		upstreamConn.Close()
		done <- struct{}{}
	}()

	go func() {
		io.Copy(upstreamConn, guestConn)
		guestConn.Close()
		upstreamConn.Close()
		done <- struct{}{}
	}()

	<-done // first direction finished
	<-done // second unblocked by Close()
}
