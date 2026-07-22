// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: Apache-2.0

package proxy

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"

	"github.com/gin-gonic/gin"
)

type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

// NewBufferedConn preserves bytes already read from conn into reader.
func NewBufferedConn(conn net.Conn, reader *bufio.Reader) net.Conn {
	return &bufferedConn{Conn: conn, reader: reader}
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

// ProxyBidirectionalStream relays both directions until both streams close.
func ProxyBidirectionalStream(ctx context.Context, left, right net.Conn) error {
	copyStream := func(dst, src net.Conn) error {
		_, err := io.Copy(dst, src)
		if closeWriter, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = closeWriter.CloseWrite()
		}
		return err
	}

	results := make(chan error, 2)
	go func() { results <- copyStream(left, right) }()
	go func() { results <- copyStream(right, left) }()

	select {
	case <-ctx.Done():
		_ = left.Close()
		_ = right.Close()
		<-results
		<-results
		return ctx.Err()
	case err := <-results:
		if err != nil {
			_ = left.Close()
			_ = right.Close()
			<-results
			return err
		}
	}

	select {
	case <-ctx.Done():
		_ = left.Close()
		_ = right.Close()
		<-results
		return ctx.Err()
	case err := <-results:
		return err
	}
}

var proxyTransport = &http.Transport{
	MaxIdleConns:        100,
	MaxIdleConnsPerHost: 100,
	DialContext: (&net.Dialer{
		KeepAlive: 30 * time.Second,
	}).DialContext,
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
			Director: func(req *http.Request) {
				req.Host = target.Host
				req.URL.Scheme = target.Scheme
				req.URL.Host = target.Host
				req.URL.Path = target.Path
				if target.RawQuery == "" || req.URL.RawQuery == "" {
					req.URL.RawQuery = target.RawQuery + req.URL.RawQuery
				} else {
					req.URL.RawQuery = target.RawQuery + "&" + req.URL.RawQuery
				}
				for key, value := range extraHeaders {
					req.Header.Add(key, value)
				}
			},
			Transport:      proxyTransport,
			ModifyResponse: modifyResponse,
		}

		reverseProxy.ServeHTTP(ctx.Writer, ctx.Request)
	}
}
