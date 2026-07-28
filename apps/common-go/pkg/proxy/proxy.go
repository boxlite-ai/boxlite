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

type RequestTarget struct {
	URL       *url.URL
	Host      string
	Headers   map[string]string
	Transport http.RoundTripper
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
func NewProxyRequestHandler(getProxyTarget func(*gin.Context) (*RequestTarget, error), modifyResponse func(*http.Response) error) gin.HandlerFunc {
	return func(ctx *gin.Context) {
		target, err := getProxyTarget(ctx)
		if err != nil {
			// Error already sent to the context
			return
		}

		if target == nil || target.URL == nil {
			return
		}

		reverseProxy := &httputil.ReverseProxy{
			Rewrite: func(req *httputil.ProxyRequest) {
				req.Out.Host = target.Host
				req.Out.URL.Scheme = target.URL.Scheme
				req.Out.URL.Host = target.URL.Host
				req.Out.URL.Path = target.URL.Path
				req.Out.URL.RawPath = target.URL.RawPath
				if target.URL.RawQuery == "" || req.In.URL.RawQuery == "" {
					req.Out.URL.RawQuery = target.URL.RawQuery + req.In.URL.RawQuery
				} else {
					req.Out.URL.RawQuery = target.URL.RawQuery + "&" + req.In.URL.RawQuery
				}

				req.Out.Header.Del("Forwarded")
				req.Out.Header.Del("X-Forwarded-For")
				req.Out.Header.Del("X-Forwarded-Port")
				req.Out.Header.Del("X-Real-IP")
				req.SetXForwarded()
				for key, value := range target.Headers {
					if value != "" {
						req.Out.Header.Set(key, value)
					}
				}
			},
			Transport:      target.Transport,
			ModifyResponse: modifyResponse,
		}
		if reverseProxy.Transport == nil {
			reverseProxy.Transport = proxyTransport
		}

		reverseProxy.ServeHTTP(ctx.Writer, ctx.Request)
	}
}
