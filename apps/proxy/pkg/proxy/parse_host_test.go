// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/boxlite-ai/proxy/cmd/proxy/config"
	"github.com/gin-gonic/gin"
)

func TestParseHostReturnsCanonicalPort(t *testing.T) {
	for _, label := range []string{"3000", "03000", "003000"} {
		port, _, _, err := (&Proxy{}).parseHost(label + "-AbCdEf123456.proxy.test")
		if err != nil || port != 3000 {
			t.Fatalf("parseHost(%q) port = %d, err = %v; want 3000", label, port, err)
		}
	}
}

func TestParseHostRejectsOutOfRangePort(t *testing.T) {
	for _, label := range []string{"0", "+3000", "-1", "65536"} {
		if _, _, _, err := (&Proxy{}).parseHost(label + "-AbCdEf123456.proxy.test"); err == nil {
			t.Fatalf("parseHost accepted port label %q", label)
		}
	}
}

func TestZeroPaddedTerminalPortRoutesToTerminal(t *testing.T) {
	proxy := newTunnelProxy(t, http.StatusNotFound)
	if err := proxy.boxAuthKeyValidCache.Set(context.Background(), "AbCdEf123456:owner-key", true, time.Minute); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "http://022222-d-416243644566313233343536.proxy.test/", nil)
	request.Header.Set(BOX_AUTH_KEY_HEADER, "owner-key")
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = request

	target, err := proxy.GetProxyTarget(ctx)
	stopActivityPoll(ctx)
	if err != nil || target == nil {
		t.Fatalf("zero-padded terminal port rejected: target=%v err=%v", target, err)
	}
	if target.URL.Path != "/boxes/AbCdEf123456/toolbox/proxy/22222/" {
		t.Fatalf("zero-padded terminal port reached %s, want the runner terminal", target.URL)
	}
}

func TestZeroPaddedTerminalPortSkipsBrowserWarning(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.Use((&Proxy{config: &config.Config{}}).browserWarningMiddleware())
	engine.GET("/", func(ctx *gin.Context) { ctx.Status(http.StatusNoContent) })
	request := httptest.NewRequest(http.MethodGet, "http://022222-d-416243644566313233343536.proxy.test/", nil)
	request.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")
	response := httptest.NewRecorder()

	engine.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("zero-padded terminal port got status %d, want the terminal to skip the warning page", response.Code)
	}
}
