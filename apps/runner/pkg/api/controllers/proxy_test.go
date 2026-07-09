// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package controllers

import (
	"errors"
	"net/http"
	"net/url"
	"testing"

	common_proxy "github.com/boxlite-ai/common-go/pkg/proxy"
	"github.com/boxlite-ai/runner/internal/constants"
)

func TestIsTerminalToolboxPath(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{"", true},
		{"/", true},
		{"proxy/22222", true},
		{"/proxy/22222", true},
		{"/proxy/22222/", true},
		{"/proxy/22222/vnc.html", true},
		{"/proxy/6080/", false},
		{"/computeruse/status", false},
		{"/process/execute", false},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			if got := isTerminalToolboxPath(tt.path); got != tt.want {
				t.Fatalf("isTerminalToolboxPath(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

func TestToolboxEscapedPathPreservesEscapedSlash(t *testing.T) {
	req, err := http.NewRequest(http.MethodGet, "http://runner.local/boxes/box/toolbox/proxy/3999/files/a%2Fb?download=1", nil)
	if err != nil {
		t.Fatal(err)
	}

	got := toolboxEscapedPath(req, "box", "/proxy/3999/files/a/b")
	want := "/proxy/3999/files/a%2Fb"
	if got != want {
		t.Fatalf("toolboxEscapedPath = %q, want %q", got, want)
	}
}

func TestNetworkProxyEscapedPathPreservesEscapedSlash(t *testing.T) {
	req, err := http.NewRequest(http.MethodGet, "http://runner.local/v1/boxes/box/network/proxy/3999/files/a%2Fb?download=1", nil)
	if err != nil {
		t.Fatal(err)
	}

	got := networkProxyEscapedPath(req, "box", "3999", "/files/a/b")
	want := "/files/a%2Fb"
	if got != want {
		t.Fatalf("networkProxyEscapedPath = %q, want %q", got, want)
	}
}

func TestParseGuestPortProxyPathPreservesEscapedSlash(t *testing.T) {
	port, targetPath, ok, err := parseGuestPortProxyPath("/proxy/3999/files/a%2Fb")
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("parseGuestPortProxyPath did not recognize port proxy path")
	}
	if port != 3999 {
		t.Fatalf("port = %d, want 3999", port)
	}
	if targetPath != "/files/a%2Fb" {
		t.Fatalf("targetPath = %q, want %q", targetPath, "/files/a%2Fb")
	}
}

func TestSetEscapedURLPathPreservesEscapedSlash(t *testing.T) {
	target := &url.URL{Scheme: "http", Host: "127.0.0.1:3999"}
	setEscapedURLPath(target, "/files/a%2Fb")

	if target.Path != "/files/a/b" {
		t.Fatalf("Path = %q, want %q", target.Path, "/files/a/b")
	}
	if target.RawPath != "/files/a%2Fb" {
		t.Fatalf("RawPath = %q, want %q", target.RawPath, "/files/a%%2Fb")
	}
	if got := target.EscapedPath(); got != "/files/a%2Fb" {
		t.Fatalf("EscapedPath = %q, want %q", got, "/files/a%2Fb")
	}
}

func TestConfigureGuestPortProxyRequestPreservesPreviewHost(t *testing.T) {
	target := &url.URL{Scheme: "http", Host: "127.0.0.1:3999", Path: "/health"}
	req, err := http.NewRequest(http.MethodGet, "http://runner.local/boxes/box/toolbox/proxy/3999/health?debug=1", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = "runner.local"
	req.Header.Set("X-Forwarded-Host", "3999-signedtoken.proxy.dev.boxlite.ai")
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-Forwarded-Port", "443")
	req.Header.Set("X-Forwarded-For", "203.0.113.8")
	req.Header.Set("Forwarded", `host="evil.example";proto=http`)
	req.Header.Set("X-Real-IP", "198.51.100.10")
	req.Header.Set(constants.BOXLITE_AUTHORIZATION_HEADER, "Bearer runner-secret")

	configureGuestPortProxyRequest(req, target, common_proxy.ForwardedRequestInfo{
		Host:  "3999-signedtoken.proxy.dev.boxlite.ai",
		Proto: "https",
		Port:  "443",
		For:   "203.0.113.8",
	})

	if req.Host != "3999-signedtoken.proxy.dev.boxlite.ai" {
		t.Fatalf("Host = %q", req.Host)
	}
	if req.URL.Scheme != "http" || req.URL.Host != "127.0.0.1:3999" || req.URL.Path != "/health" {
		t.Fatalf("target URL = %s", req.URL.String())
	}
	if req.URL.RawQuery != "debug=1" {
		t.Fatalf("RawQuery = %q", req.URL.RawQuery)
	}
	if got := req.Header.Get("X-Forwarded-Host"); got != "3999-signedtoken.proxy.dev.boxlite.ai" {
		t.Fatalf("X-Forwarded-Host = %q", got)
	}
	if got := req.Header.Get("X-Forwarded-Proto"); got != "https" {
		t.Fatalf("X-Forwarded-Proto = %q", got)
	}
	if got := req.Header.Get("X-Forwarded-Port"); got != "443" {
		t.Fatalf("X-Forwarded-Port = %q", got)
	}
	if got := req.Header.Get("X-Forwarded-For"); got != "203.0.113.8" {
		t.Fatalf("X-Forwarded-For = %q", got)
	}
	if got := req.Header.Get("Forwarded"); got != `host="3999-signedtoken.proxy.dev.boxlite.ai";proto=https` {
		t.Fatalf("Forwarded = %q", got)
	}
	if got := req.Header.Get("X-Real-IP"); got != "" {
		t.Fatalf("X-Real-IP leaked to guest: %q", got)
	}
	if got := req.Header.Get(constants.BOXLITE_AUTHORIZATION_HEADER); got != "" {
		t.Fatalf("runner auth header leaked to guest: %q", got)
	}
}

func TestConfigureGuestPortProxyRequestPreservesEscapedPath(t *testing.T) {
	target := &url.URL{Scheme: "http", Host: "127.0.0.1:3999"}
	setEscapedURLPath(target, "/files/a%2Fb")
	req, err := http.NewRequest(http.MethodGet, "http://runner.local/boxes/box/toolbox/proxy/3999/files/a%2Fb", nil)
	if err != nil {
		t.Fatal(err)
	}

	configureGuestPortProxyRequest(req, target, common_proxy.ForwardedRequestInfo{})

	if req.URL.Path != "/files/a/b" {
		t.Fatalf("Path = %q, want %q", req.URL.Path, "/files/a/b")
	}
	if req.URL.RawPath != "/files/a%2Fb" {
		t.Fatalf("RawPath = %q, want %q", req.URL.RawPath, "/files/a%%2Fb")
	}
	if got := req.URL.EscapedPath(); got != "/files/a%2Fb" {
		t.Fatalf("EscapedPath = %q, want %q", got, "/files/a%2Fb")
	}
}

func TestGuestPortProxyErrorMessageHidesTunnelResetDetails(t *testing.T) {
	err := errors.New("read unix @->/tmp/bl-0/box/gvproxy-ctl.sock: read: connection reset by peer")
	got := guestPortProxyErrorMessage(3030, err)
	want := "guest service on port 3030 is not accepting connections"
	if got != want {
		t.Fatalf("guestPortProxyErrorMessage = %q, want %q", got, want)
	}
}

func TestGuestPortProxyErrorMessageKeepsUnexpectedErrors(t *testing.T) {
	err := errors.New("runner lookup failed")
	got := guestPortProxyErrorMessage(3030, err)
	want := "guest port proxy failed: runner lookup failed"
	if got != want {
		t.Fatalf("guestPortProxyErrorMessage = %q, want %q", got, want)
	}
}

func TestForwardedRequestInfoUsesTrustedLastHeaderValue(t *testing.T) {
	header := http.Header{}
	header.Add("X-Forwarded-Host", "evil.example")
	header.Add("X-Forwarded-Host", "3999-signedtoken.proxy.dev.boxlite.ai")
	header.Add("X-Forwarded-Proto", "http, https")
	header.Add("X-Forwarded-Port", "80, 443")
	header.Add("X-Forwarded-For", "198.51.100.10")
	header.Add("X-Forwarded-For", "203.0.113.8")

	info := common_proxy.ForwardedRequestInfoFromHeaders(header)
	if info.Host != "3999-signedtoken.proxy.dev.boxlite.ai" {
		t.Fatalf("Host = %q", info.Host)
	}
	if info.Proto != "https" {
		t.Fatalf("Proto = %q", info.Proto)
	}
	if info.Port != "443" {
		t.Fatalf("Port = %q", info.Port)
	}
	if info.For != "198.51.100.10, 203.0.113.8" {
		t.Fatalf("For = %q", info.For)
	}
}
