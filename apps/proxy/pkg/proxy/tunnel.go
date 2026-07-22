// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"time"

	common_proxy "github.com/boxlite-ai/common-go/pkg/proxy"
)

const runnerTunnelSetupTimeout = 10 * time.Second

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
	isPublic, err := p.getBoxPublic(request.Context(), boxID)
	if err != nil {
		http.Error(writer, "box visibility unavailable", http.StatusBadGateway)
		return
	}
	if !*isPublic {
		http.Error(writer, "box is not public", http.StatusForbidden)
		return
	}
	runnerInfo, err := p.getBoxRunnerInfo(request.Context(), boxID)
	if err != nil {
		http.Error(writer, "runner unavailable", http.StatusBadGateway)
		return
	}

	runnerConn, err := dialRunnerTunnel(request.Context(), runnerInfo, boxID, port)
	if err != nil {
		http.Error(writer, "runner tunnel unavailable", http.StatusBadGateway)
		return
	}
	defer runnerConn.Close()

	hijacker, ok := writer.(http.Hijacker)
	if !ok {
		http.Error(writer, "connection hijacking unavailable", http.StatusInternalServerError)
		return
	}
	clientConn, buffered, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer clientConn.Close()
	if _, err := buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}
	if err := buffered.Flush(); err != nil {
		return
	}

	common_proxy.ProxyBidirectionalStream(clientConn, runnerConn)
}

func (p *Proxy) tunnelTarget(request *http.Request) (string, uint16, error) {
	port, boxID, _, err := p.parseHost(request.Host)
	if err != nil || boxID == "" {
		return "", 0, fmt.Errorf("invalid tunnel host")
	}
	if decoded, ok, decodeErr := decodeDirectPreviewBoxID(boxID); decodeErr != nil {
		return "", 0, decodeErr
	} else if ok {
		boxID = decoded
	}
	value, err := strconv.ParseUint(port, 10, 16)
	if err != nil || value == 0 {
		return "", 0, fmt.Errorf("invalid tunnel port")
	}
	return boxID, uint16(value), nil
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
		response.Body.Close()
		conn.Close()
		return nil, fmt.Errorf("runner CONNECT returned %s", response.Status)
	}
	if err := conn.SetDeadline(time.Time{}); err != nil {
		conn.Close()
		return nil, err
	}
	return &bufferedConn{Conn: conn, reader: reader}, nil
}

type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedConn) Read(payload []byte) (int, error) {
	return c.reader.Read(payload)
}

func (c *bufferedConn) CloseWrite() error {
	if conn, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return conn.CloseWrite()
	}
	return errors.ErrUnsupported
}
