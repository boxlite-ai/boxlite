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
	"strings"
	"time"

	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
	common_proxy "github.com/boxlite-ai/common-go/pkg/proxy"
	"github.com/boxlite-ai/common-go/pkg/utils"
	log "github.com/sirupsen/logrus"
)

const runnerTunnelSetupTimeout = 10 * time.Second

const (
	networkTunnelTokenPrefix       = "t-"
	networkTunnelTokenRandomLength = 32
)

var errInvalidNetworkTunnelToken = errors.New("invalid or expired network tunnel capability")

func (p *Proxy) handleTunnelConnect(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodConnect {
		http.Error(writer, "CONNECT required", http.StatusMethodNotAllowed)
		return
	}
	token, port, err := p.tunnelTarget(request)
	if err != nil {
		http.Error(writer, err.Error(), http.StatusBadRequest)
		return
	}
	boxID, err := p.resolveNetworkTunnelToken(request.Context(), token, port)
	if err != nil {
		if errors.Is(err, errInvalidNetworkTunnelToken) {
			http.Error(writer, "invalid or expired network tunnel capability", http.StatusForbidden)
		} else {
			http.Error(writer, "network tunnel authorization unavailable", http.StatusBadGateway)
		}
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

	clientConn, err := common_proxy.AcceptConnect(writer)
	if err != nil {
		return
	}
	defer clientConn.Close()

	if err := common_proxy.ProxyBidirectionalStream(request.Context(), clientConn, runnerConn); err != nil {
		log.WithError(err).WithFields(log.Fields{"box": boxID, "port": port}).Warn("tunnel stream closed with error")
	}
}

func (p *Proxy) tunnelTarget(request *http.Request) (string, uint16, error) {
	port, token, _, err := p.parseHost(request.Host)
	if err != nil || !isNetworkTunnelToken(token) {
		return "", 0, fmt.Errorf("invalid tunnel host")
	}
	value, err := strconv.ParseUint(port, 10, 16)
	if err != nil || value == 0 {
		return "", 0, fmt.Errorf("invalid tunnel port")
	}
	return token, uint16(value), nil
}

func isNetworkTunnelToken(token string) bool {
	if len(token) != len(networkTunnelTokenPrefix)+networkTunnelTokenRandomLength ||
		!strings.HasPrefix(token, networkTunnelTokenPrefix) {
		return false
	}
	for _, ch := range token[len(networkTunnelTokenPrefix):] {
		if (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'z') {
			continue
		}
		return false
	}
	return true
}

func (p *Proxy) resolveNetworkTunnelToken(ctx context.Context, token string, port uint16) (string, error) {
	var boxID string
	err := utils.RetryWithExponentialBackoff(
		ctx,
		"resolve network tunnel capability",
		proxyMaxRetries,
		proxyBaseDelay,
		proxyMaxDelay,
		func() error {
			resolvedBoxID, response, err := p.apiclient.PreviewAPI.
				GetBoxIdFromSignedPreviewUrlToken(ctx, token, float32(port)).
				Execute()
			if err == nil {
				if resolvedBoxID == "" {
					return &utils.NonRetryableError{Err: errInvalidNetworkTunnelToken}
				}
				boxID = resolvedBoxID
				return nil
			}

			if response != nil &&
				response.StatusCode >= http.StatusBadRequest &&
				response.StatusCode < http.StatusInternalServerError &&
				response.StatusCode != http.StatusRequestTimeout &&
				response.StatusCode != http.StatusTooManyRequests {
				return &utils.NonRetryableError{Err: errInvalidNetworkTunnelToken}
			}

			openapiErr := common_errors.ConvertOpenAPIError(err)
			if openapiErr != nil && !common_errors.IsRetryableOpenAPIError(openapiErr) {
				return &utils.NonRetryableError{Err: openapiErr}
			}
			return openapiErr
		},
	)
	if err != nil {
		return "", err
	}
	return boxID, nil
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
	return common_proxy.NewBufferedConn(conn, reader), nil
}
