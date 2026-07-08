// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"net/http/httptest"
	"testing"

	common_proxy "github.com/boxlite-ai/common-go/pkg/proxy"
)

func TestRequestEscapedPathPreservesEscapedSlash(t *testing.T) {
	req := httptest.NewRequest("GET", "https://3999-token.proxy.dev.boxlite.ai/files/a%2Fb?download=1", nil)

	got := requestEscapedPath(req.URL, "/files/a/b")
	want := "/files/a%2Fb"
	if got != want {
		t.Fatalf("requestEscapedPath = %q, want %q", got, want)
	}
}

func TestRequestEscapedPathUsesFallbackWhenRequestPathIsEmpty(t *testing.T) {
	got := requestEscapedPath(nil, "health")
	want := "/health"
	if got != want {
		t.Fatalf("requestEscapedPath fallback = %q, want %q", got, want)
	}
}

func TestForwardedPortFromHost(t *testing.T) {
	tests := []struct {
		name  string
		host  string
		proto string
		want  string
	}{
		{name: "explicit port", host: "3999-token.proxy.dev.boxlite.ai:8443", proto: "https", want: "8443"},
		{name: "https default", host: "3999-token.proxy.dev.boxlite.ai", proto: "https", want: "443"},
		{name: "http default", host: "3999-token.proxy.dev.boxlite.ai", proto: "http", want: "80"},
		{name: "unknown proto", host: "3999-token.proxy.dev.boxlite.ai", proto: "tcp", want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := forwardedPortFromHost(tt.host, tt.proto); got != tt.want {
				t.Fatalf("forwardedPortFromHost(%q, %q) = %q, want %q", tt.host, tt.proto, got, tt.want)
			}
		})
	}
}

func TestFormatForwardedHeader(t *testing.T) {
	got := common_proxy.FormatForwardedHeader("3999-token.proxy.dev.boxlite.ai", "https")
	want := `host="3999-token.proxy.dev.boxlite.ai";proto=https`
	if got != want {
		t.Fatalf("formatForwardedHeader = %q, want %q", got, want)
	}
}
