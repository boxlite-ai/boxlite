// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

package proxy

import (
	"bufio"
	"bytes"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestProxyBidirectionalStreamRelaysBothDirections(t *testing.T) {
	client, proxyClient := net.Pipe()
	proxyGuest, guest := net.Pipe()
	done := make(chan struct{})
	go func() {
		ProxyBidirectionalStream(proxyClient, proxyGuest)
		close(done)
	}()

	if _, err := client.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	guestPayload := make([]byte, 4)
	if _, err := io.ReadFull(guest, guestPayload); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(guestPayload, []byte("ping")) {
		t.Fatalf("guest received %q", guestPayload)
	}
	if _, err := guest.Write([]byte("pong")); err != nil {
		t.Fatal(err)
	}
	responsePayload := make([]byte, 4)
	if _, err := io.ReadFull(client, responsePayload); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(responsePayload, []byte("pong")) {
		t.Fatalf("client received %q", responsePayload)
	}

	_ = client.Close()
	select {
	case <-done:
		t.Fatal("proxy returned before the guest direction finished")
	case <-time.After(50 * time.Millisecond):
	}
	_ = guest.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("proxy did not return after both directions finished")
	}
}

func TestBufferedConnPreservesBufferedBytes(t *testing.T) {
	conn, peer := net.Pipe()
	defer conn.Close()
	defer peer.Close()

	reader := bufio.NewReader(conn)
	go func() {
		_, _ = peer.Write([]byte("buffered-and-live"))
	}()
	if got, err := reader.Peek(len("buffered")); err != nil || string(got) != "buffered" {
		t.Fatalf("Peek() = %q, %v", got, err)
	}

	wrapped := NewBufferedConn(conn, reader)
	payload := make([]byte, len("buffered-and-live"))
	if _, err := io.ReadFull(wrapped, payload); err != nil {
		t.Fatal(err)
	}
	if string(payload) != "buffered-and-live" {
		t.Fatalf("Read() = %q", payload)
	}
}

func TestRewriteProxyRequestSetsTrustedForwardedHeaders(t *testing.T) {
	gin.SetMode(gin.TestMode)
	requests := make(chan *http.Request, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		requests <- req.Clone(req.Context())
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	target, err := url.Parse(upstream.URL + "/boxes/box/toolbox/proxy/3999/app?target=1")
	if err != nil {
		t.Fatal(err)
	}

	router := gin.New()
	router.GET("/*path", NewProxyRequestHandler(func(*gin.Context) (*url.URL, map[string]string, error) {
		return target, map[string]string{
			"X-BoxLite-Authorization": "Bearer runner-secret",
			"X-Forwarded-Host":        "3999-token.proxy.dev.boxlite.ai",
			"X-Forwarded-Proto":       "https",
			"X-Forwarded-Port":        "443",
			"Forwarded":               `host="3999-token.proxy.dev.boxlite.ai";proto=https`,
		}, nil
	}, nil))
	proxyServer := httptest.NewServer(router)
	defer proxyServer.Close()

	in, err := http.NewRequest(http.MethodGet, proxyServer.URL+"/app?client=1", nil)
	if err != nil {
		t.Fatal(err)
	}
	in.Host = "3999-token.proxy.dev.boxlite.ai"
	in.Header.Set("X-Forwarded-Host", "evil.example")
	in.Header.Set("X-Forwarded-Proto", "http")
	in.Header.Set("X-Forwarded-Port", "1234")
	in.Header.Set("Forwarded", `host="evil.example";proto=http`)
	in.Header.Set("X-Real-IP", "198.51.100.10")

	resp, err := proxyServer.Client().Do(in)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("proxy status = %d", resp.StatusCode)
	}

	select {
	case out := <-requests:
		assertTrustedForwardedRequest(t, out)
	default:
		t.Fatal("upstream did not receive a proxied request")
	}
}

func assertTrustedForwardedRequest(t *testing.T, out *http.Request) {
	t.Helper()
	upstreamHost, _, err := net.SplitHostPort(out.Host)
	if err != nil || upstreamHost != "127.0.0.1" {
		t.Fatalf("Host = %q", out.Host)
	}
	if out.URL.Path != "/boxes/box/toolbox/proxy/3999/app" {
		t.Fatalf("target URL = %s", out.URL.String())
	}
	if out.URL.RawQuery != "target=1&client=1" {
		t.Fatalf("RawQuery = %q", out.URL.RawQuery)
	}
	if got := out.Header.Get("X-Forwarded-For"); got == "" {
		t.Fatalf("X-Forwarded-For = %q", got)
	}
	if got := out.Header.Get("X-Forwarded-Host"); got != "3999-token.proxy.dev.boxlite.ai" {
		t.Fatalf("X-Forwarded-Host = %q", got)
	}
	if got := out.Header.Get("X-Forwarded-Proto"); got != "https" {
		t.Fatalf("X-Forwarded-Proto = %q", got)
	}
	if got := out.Header.Get("X-Forwarded-Port"); got != "443" {
		t.Fatalf("X-Forwarded-Port = %q", got)
	}
	if got := out.Header.Get("Forwarded"); got != `host="3999-token.proxy.dev.boxlite.ai";proto=https` {
		t.Fatalf("Forwarded = %q", got)
	}
	if got := out.Header.Get("X-Real-IP"); got != "" {
		t.Fatalf("X-Real-IP leaked to runner: %q", got)
	}
	if got := out.Header.Get("X-BoxLite-Authorization"); got != "Bearer runner-secret" {
		t.Fatalf("X-BoxLite-Authorization = %q", got)
	}
}
