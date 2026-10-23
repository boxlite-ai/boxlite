// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	common_proxy "github.com/boxlite-ai/common-go/pkg/proxy"
)

const runnerTunnelSetupTimeout = 10 * time.Second

const tunnelBoxIDPrefix = "d-"

func (p *Proxy) handleTunnelConnect(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodConnect {
		http.Error(writer, "CONNECT required", http.StatusMethodNotAllowed)
		return
	}
	boxID, port, err := p.tunnelTarget(request)
	if err != nil {
		http.Error(writer, err.Error(), http.StatusBadRequest)
		return
	}
	inboundEnabled, err := p.getBoxInboundEnabled(request.Context(), boxID)
	if err != nil {
		http.Error(writer, "box inbound mode unavailable", http.StatusBadGateway)
		return
	}
	if !*inboundEnabled {
		http.Error(writer, "box inbound access is disabled", http.StatusForbidden)
		return
	}
	if authErr := p.authorizeTunnel(writer, request, boxID, port); authErr != nil {
		http.Error(writer, authErr.message, authErr.status)
		return
	}

	// A CONNECT tunnel outlives any single HTTP request, so for tunnels the poll
	// is the renewal rather than a fallback: bind its ticker to the stream, which
	// ends when this handler returns. Renewing before the runner dial mirrors the
	// API-side proxy, which renews ahead of its own readiness gate so a box being
	// actively reached for is not reaped while the path to it is still coming up.
	activityPoll := newActivityPollController()
	defer activityPoll.stop()
	go p.updateLastActivity(context.WithoutCancel(request.Context()), boxID, true, activityPoll.done)

	runnerConn, err := p.dialGuestPortWithWake(request.Context(), boxID, port)
	if err != nil {
		failure := guestDialFailure(writer.Header(), err)
		http.Error(writer, failure.Message, failure.StatusCode)
		return
	}
	defer runnerConn.Close()

	clientConn, err := common_proxy.AcceptConnect(writer)
	if err != nil {
		return
	}
	defer clientConn.Close()

	if err := common_proxy.ProxyBidirectionalStream(request.Context(), clientConn, runnerConn); err != nil {
		slog.WarnContext(request.Context(), "tunnel stream closed with error", "box", boxID, "port", port, "error", err)
	}
}

func (p *Proxy) tunnelTarget(request *http.Request) (string, uint16, error) {
	port, boxID, _, err := p.parseHost(request.Host)
	if err != nil || boxID == "" {
		return "", 0, fmt.Errorf("invalid tunnel host")
	}
	if decoded, ok, decodeErr := decodeTunnelBoxID(boxID); decodeErr != nil {
		return "", 0, decodeErr
	} else if ok {
		boxID = decoded
	}
	return boxID, port, nil
}

func decodeTunnelBoxID(value string) (string, bool, error) {
	encoded, ok := strings.CutPrefix(value, tunnelBoxIDPrefix)
	if !ok {
		return value, false, nil
	}
	decoded, err := hex.DecodeString(encoded)
	if err != nil || len(decoded) != 12 {
		return "", true, fmt.Errorf("invalid tunnel box ID")
	}
	boxID := string(decoded)
	for _, ch := range boxID {
		if (ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') {
			continue
		}
		return "", true, fmt.Errorf("invalid tunnel box ID")
	}
	return boxID, true, nil
}

func dialRunnerTunnel(ctx context.Context, runnerInfo *RunnerInfo, boxID string, port uint16) (net.Conn, error) {
	target, err := url.Parse(runnerInfo.ApiUrl)
	if err != nil {
		return nil, err
	}
	host := target.Host
	if _, _, err := net.SplitHostPort(host); err != nil {
		if target.Scheme == "https" {
			host = net.JoinHostPort(host, "443")
		} else {
			host = net.JoinHostPort(host, "80")
		}
	}

	dialCtx, cancel := context.WithTimeout(ctx, runnerTunnelSetupTimeout)
	defer cancel()
	dialer := &net.Dialer{Timeout: runnerTunnelSetupTimeout}
	var conn net.Conn
	if target.Scheme == "https" {
		conn, err = (&tls.Dialer{NetDialer: dialer, Config: &tls.Config{
			ServerName: target.Hostname(),
			MinVersion: tls.VersionTLS12,
		}}).DialContext(dialCtx, "tcp", host)
	} else {
		conn, err = dialer.DialContext(dialCtx, "tcp", host)
	}
	if err != nil {
		return nil, err
	}
	if err := conn.SetDeadline(time.Now().Add(runnerTunnelSetupTimeout)); err != nil {
		conn.Close()
		return nil, err
	}

	path := fmt.Sprintf("/v1/boxes/%s/network/tunnel?port=%d", url.PathEscape(boxID), port)
	req, err := http.NewRequestWithContext(ctx, http.MethodConnect, "http://"+host+path, nil)
	if err != nil {
		conn.Close()
		return nil, err
	}
	req.Host = host
	req.Header.Set("X-BoxLite-Authorization", "Bearer "+runnerInfo.ApiKey)
	if err := req.Write(conn); err != nil {
		conn.Close()
		return nil, err
	}

	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, req)
	if err != nil {
		conn.Close()
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		var body struct {
			Code string `json:"code"`
		}
		_ = json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&body)
		response.Body.Close()
		conn.Close()
		return nil, &runnerTunnelError{statusCode: response.StatusCode, code: body.Code}
	}
	if err := conn.SetDeadline(time.Time{}); err != nil {
		conn.Close()
		return nil, err
	}
	return common_proxy.NewBufferedConn(conn, reader), nil
}
