// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

package proxy

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

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
	router.GET("/*path", NewProxyRequestHandler(func(*gin.Context) (*RequestTarget, error) {
		return &RequestTarget{
			URL:  target,
			Host: "3999-token.proxy.dev.boxlite.ai",
			Headers: map[string]string{
				"X-BoxLite-Authorization": "Bearer runner-secret",
				"X-Forwarded-Host":        "3999-token.proxy.dev.boxlite.ai",
				"X-Forwarded-Proto":       "https",
				"X-Forwarded-Port":        "443",
			},
		}, nil
	}, nil, nil))
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
	in.Header.Set("X-Forwarded-For", "198.51.100.10")
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
	if out.Host != "3999-token.proxy.dev.boxlite.ai" {
		t.Fatalf("Host = %q", out.Host)
	}
	if out.URL.Path != "/boxes/box/toolbox/proxy/3999/app" {
		t.Fatalf("target URL = %s", out.URL.String())
	}
	if out.URL.RawQuery != "target=1&client=1" {
		t.Fatalf("RawQuery = %q", out.URL.RawQuery)
	}
	if got := out.Header.Get("X-Forwarded-For"); got == "" || strings.Contains(got, "198.51.100.10") {
		t.Fatalf("X-Forwarded-For retained the untrusted value: %q", got)
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
	if got := out.Header.Get("Forwarded"); got != "" {
		t.Fatalf("Forwarded retained the untrusted value: %q", got)
	}
	if got := out.Header.Get("X-Real-IP"); got != "" {
		t.Fatalf("X-Real-IP leaked to runner: %q", got)
	}
	if got := out.Header.Get("X-BoxLite-Authorization"); got != "Bearer runner-secret" {
		t.Fatalf("X-BoxLite-Authorization = %q", got)
	}
}

// httputil answers a failed dial with a bare 502 and an empty body. A service
// that can say something more useful — "this box is starting, retry" — needs
// the hook to actually reach ReverseProxy.ErrorHandler, and needs httputil to
// have written nothing by the time it runs, or the handler's own response is
// discarded as a second WriteHeader.
func TestProxyRequestHandlerRoutesUpstreamFailuresToTheHook(t *testing.T) {
	gin.SetMode(gin.TestMode)

	var seen error
	router := gin.New()
	router.GET("/*path", NewProxyRequestHandler(
		func(*gin.Context) (*RequestTarget, error) {
			return &RequestTarget{URL: deadTarget(t), Host: "box.proxy.test"}, nil
		},
		nil,
		func(ctx *gin.Context, err error) {
			seen = err
			ctx.Header("Retry-After", "15")
			ctx.JSON(http.StatusServiceUnavailable, gin.H{"code": "box_starting"})
		},
	))

	response, body := getThrough(t, router)
	defer response.Body.Close()

	if seen == nil {
		t.Fatal("the hook was never called; ErrorHandler is not wired")
	}
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 — httputil's 502 won", response.StatusCode)
	}
	if got := response.Header.Get("Retry-After"); got != "15" {
		t.Fatalf("Retry-After = %q, want the hook's value", got)
	}
	if !strings.Contains(body, "box_starting") {
		t.Fatalf("body = %q, want the hook's payload", body)
	}
}

// With no hook, the default must not change for existing callers.
func TestProxyRequestHandlerKeepsHttputilDefaultWithoutAHook(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/*path", NewProxyRequestHandler(func(*gin.Context) (*RequestTarget, error) {
		return &RequestTarget{URL: deadTarget(t), Host: "box.proxy.test"}, nil
	}, nil, nil))

	response, _ := getThrough(t, router)
	defer response.Body.Close()

	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want httputil's 502 when no hook is supplied", response.StatusCode)
	}
}

// deadTarget is a URL nothing listens on: a port reserved and then released,
// so the dial fails rather than hanging.
func deadTarget(t *testing.T) *url.URL {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	target, err := url.Parse("http://" + address + "/app")
	if err != nil {
		t.Fatal(err)
	}
	return target
}

// getThrough drives the router over a real connection: gin's writer needs an
// http.CloseNotifier on this path, which httptest.ResponseRecorder is not.
func getThrough(t *testing.T, router *gin.Engine) (*http.Response, string) {
	t.Helper()
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)

	response, err := server.Client().Get(server.URL + "/app")
	if err != nil {
		t.Fatal(err)
	}
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response, string(payload)
}
