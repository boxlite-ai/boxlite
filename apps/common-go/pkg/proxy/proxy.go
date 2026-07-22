// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: Apache-2.0

package proxy

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// ProxyBidirectionalStream relays both directions until both streams close.
func ProxyBidirectionalStream(left, right net.Conn) {
	copyStream := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		if closeWriter, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = closeWriter.CloseWrite()
		}
	}

	done := make(chan struct{})
	go func() {
		copyStream(left, right)
		close(done)
	}()
	copyStream(right, left)
	<-done
}

var proxyTransport = &http.Transport{
	MaxIdleConns:        100,
	MaxIdleConnsPerHost: 100,
	DialContext: (&net.Dialer{
		KeepAlive: 30 * time.Second,
	}).DialContext,
}

func FormatForwardedHeader(host string, proto string) string {
	parts := make([]string, 0, 2)
	if host != "" {
		parts = append(parts, fmt.Sprintf("host=%q", host))
	}
	if proto != "" {
		parts = append(parts, "proto="+proto)
	}
	return strings.Join(parts, ";")
}

type ForwardedRequestInfo struct {
	Host  string
	Proto string
	Port  string
	For   string
}

func ForwardedRequestInfoFromHeaders(header http.Header) ForwardedRequestInfo {
	return ForwardedRequestInfo{
		Host:  lastForwardedHeaderValue(header.Values("X-Forwarded-Host")),
		Proto: lastForwardedHeaderValue(header.Values("X-Forwarded-Proto")),
		Port:  lastForwardedHeaderValue(header.Values("X-Forwarded-Port")),
		For:   joinForwardedFor(header.Values("X-Forwarded-For")),
	}
}

func ApplyTrustedForwardedHeaders(header http.Header, forwarded ForwardedRequestInfo) {
	ClearForwardedHeaders(header)
	if forwarded.For != "" {
		header.Set("X-Forwarded-For", forwarded.For)
	}
	if forwarded.Host != "" {
		header.Set("X-Forwarded-Host", forwarded.Host)
	}
	if forwarded.Proto != "" {
		header.Set("X-Forwarded-Proto", forwarded.Proto)
	}
	if forwarded.Port != "" {
		header.Set("X-Forwarded-Port", forwarded.Port)
	}
	if forwardedHeader := FormatForwardedHeader(forwarded.Host, forwarded.Proto); forwardedHeader != "" {
		header.Set("Forwarded", forwardedHeader)
	}
}

func ClearForwardedHeaders(header http.Header) {
	header.Del("Forwarded")
	header.Del("X-Forwarded-For")
	header.Del("X-Forwarded-Host")
	header.Del("X-Forwarded-Proto")
	header.Del("X-Forwarded-Port")
	header.Del("X-Real-IP")
}

func lastForwardedHeaderValue(values []string) string {
	for i := len(values) - 1; i >= 0; i-- {
		parts := strings.Split(values[i], ",")
		for j := len(parts) - 1; j >= 0; j-- {
			if value := strings.TrimSpace(parts[j]); value != "" {
				return value
			}
		}
	}
	return ""
}

func joinForwardedFor(values []string) string {
	parts := make([]string, 0, len(values))
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			if trimmed := strings.TrimSpace(part); trimmed != "" {
				parts = append(parts, trimmed)
			}
		}
	}
	return strings.Join(parts, ", ")
}

// ProxyRequest handles proxying requests to a box's container
//
//	@Tags			toolbox
//	@Summary		Proxy requests to the box toolbox
//	@Description	Forwards the request to the specified box's container
//	@Param			workspaceId	path		string	true	"Box ID"
//	@Param			projectId	path		string	true	"Project ID"
//	@Param			path		path		string	true	"Path to forward"
//	@Success		200			{object}	string	"Proxied response"
//	@Failure		400			{object}	string	"Bad request"
//	@Failure		401			{object}	string	"Unauthorized"
//	@Failure		404			{object}	string	"Box container not found"
//	@Failure		409			{object}	string	"Box container conflict"
//	@Failure		500			{object}	string	"Internal server error"
//	@Router			/workspaces/{workspaceId}/{projectId}/toolbox/{path} [get]
func NewProxyRequestHandler(getProxyTarget func(*gin.Context) (targetUrl *url.URL, extraHeaders map[string]string, err error), modifyResponse func(*http.Response) error) gin.HandlerFunc {
	return func(ctx *gin.Context) {
		target, extraHeaders, err := getProxyTarget(ctx)
		if err != nil {
			// Error already sent to the context
			return
		}

		if target == nil {
			return
		}

		reverseProxy := &httputil.ReverseProxy{
			Rewrite: func(req *httputil.ProxyRequest) {
				req.Out.Host = target.Host
				req.Out.URL.Scheme = target.Scheme
				req.Out.URL.Host = target.Host
				req.Out.URL.Path = target.Path
				req.Out.URL.RawPath = target.RawPath
				if target.RawQuery == "" || req.In.URL.RawQuery == "" {
					req.Out.URL.RawQuery = target.RawQuery + req.In.URL.RawQuery
				} else {
					req.Out.URL.RawQuery = target.RawQuery + "&" + req.In.URL.RawQuery
				}

				req.Out.Header.Del("X-Forwarded-Port")
				req.Out.Header.Del("X-Real-IP")
				req.SetXForwarded()
				for key, value := range extraHeaders {
					if value != "" {
						req.Out.Header.Set(key, value)
					}
				}
			},
			Transport:      proxyTransport,
			ModifyResponse: modifyResponse,
		}

		reverseProxy.ServeHTTP(ctx.Writer, ctx.Request)
	}
}
