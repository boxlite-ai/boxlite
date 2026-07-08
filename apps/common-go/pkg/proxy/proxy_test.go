// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

package proxy

import (
	"context"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"testing"
)

func TestRewriteProxyRequestSetsTrustedForwardedHeaders(t *testing.T) {
	in := httptest.NewRequest("GET", "https://3999-token.proxy.dev.boxlite.ai/app?client=1", nil)
	in.RemoteAddr = "203.0.113.8:12345"
	in.Host = "3999-token.proxy.dev.boxlite.ai"
	in.Header.Set("X-Forwarded-Host", "evil.example")
	in.Header.Set("X-Forwarded-Proto", "http")
	in.Header.Set("X-Forwarded-Port", "1234")
	in.Header.Set("Forwarded", `host="evil.example";proto=http`)
	in.Header.Set("X-Real-IP", "198.51.100.10")

	out := in.Clone(context.Background())
	target, err := url.Parse("http://runner.internal/boxes/box/toolbox/proxy/3999/app?target=1")
	if err != nil {
		t.Fatal(err)
	}

	rewriteProxyRequest(&httputil.ProxyRequest{In: in, Out: out}, target, map[string]string{
		"X-BoxLite-Authorization": "Bearer runner-secret",
		"X-Forwarded-Host":        "3999-token.proxy.dev.boxlite.ai",
		"X-Forwarded-Proto":       "https",
		"X-Forwarded-Port":        "443",
		"Forwarded":               `host="3999-token.proxy.dev.boxlite.ai";proto=https`,
	})

	if out.Host != "runner.internal" {
		t.Fatalf("Host = %q", out.Host)
	}
	if out.URL.Scheme != "http" || out.URL.Host != "runner.internal" || out.URL.Path != "/boxes/box/toolbox/proxy/3999/app" {
		t.Fatalf("target URL = %s", out.URL.String())
	}
	if out.URL.RawQuery != "target=1&client=1" {
		t.Fatalf("RawQuery = %q", out.URL.RawQuery)
	}
	if got := out.Header.Get("X-Forwarded-For"); got != "203.0.113.8" {
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
