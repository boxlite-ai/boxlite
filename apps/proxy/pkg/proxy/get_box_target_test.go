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

func TestRunnerNetworkProxyTargetURLUsesRestNamespace(t *testing.T) {
	got := runnerNetworkProxyTargetURL("http://runner.local:3003", "box123", "3999")
	want := "http://runner.local:3003/v1/boxes/box123/network/proxy/3999"
	if got != want {
		t.Fatalf("runnerNetworkProxyTargetURL = %q, want %q", got, want)
	}
}

func TestDecodeDirectPreviewBoxID(t *testing.T) {
	got, ok, err := decodeDirectPreviewBoxID("35334d4f5a336a70355a7531")
	if err != nil {
		t.Fatalf("decodeDirectPreviewBoxID returned error: %v", err)
	}
	if !ok {
		t.Fatal("decodeDirectPreviewBoxID did not recognize encoded direct box ID")
	}
	if got != "53MOZ3jp5Zu1" {
		t.Fatalf("decodeDirectPreviewBoxID = %q, want %q", got, "53MOZ3jp5Zu1")
	}
}

func TestDecodeDirectPreviewBoxIDRejectsDecodedPathCharacters(t *testing.T) {
	_, ok, err := decodeDirectPreviewBoxID("35334d4f5a336a702f2e2e2f")
	if err == nil {
		t.Fatal("decodeDirectPreviewBoxID returned nil error")
	}
	if !ok {
		t.Fatal("decodeDirectPreviewBoxID did not recognize encoded direct box ID")
	}
}

func TestDecodeDirectPreviewBoxIDRejectsDecodedWrongLength(t *testing.T) {
	_, ok, err := decodeDirectPreviewBoxID("35334d4f5a336a70355a75")
	if err != nil {
		t.Fatalf("decodeDirectPreviewBoxID returned error for legacy-sized value: %v", err)
	}
	if ok {
		t.Fatal("decodeDirectPreviewBoxID unexpectedly recognized non-encoded value")
	}

	_, ok, err = decodeDirectPreviewBoxID("35334d4f5a336a70355a7500")
	if err == nil {
		t.Fatal("decodeDirectPreviewBoxID returned nil error")
	}
	if !ok {
		t.Fatal("decodeDirectPreviewBoxID did not recognize encoded direct box ID")
	}
}

func TestDecodeDirectPreviewBoxIDKeepsLegacyRawValue(t *testing.T) {
	got, ok, err := decodeDirectPreviewBoxID("legacyboxid")
	if err != nil {
		t.Fatalf("decodeDirectPreviewBoxID returned error: %v", err)
	}
	if ok {
		t.Fatal("decodeDirectPreviewBoxID unexpectedly recognized legacy raw value")
	}
	if got != "legacyboxid" {
		t.Fatalf("decodeDirectPreviewBoxID = %q, want %q", got, "legacyboxid")
	}
}

func TestDecodeDirectPreviewBoxIDKeepsSignedTokenValue(t *testing.T) {
	got, ok, err := decodeDirectPreviewBoxID("abcdef0123456789")
	if err != nil {
		t.Fatalf("decodeDirectPreviewBoxID returned error: %v", err)
	}
	if ok {
		t.Fatal("decodeDirectPreviewBoxID unexpectedly recognized signed token value")
	}
	if got != "abcdef0123456789" {
		t.Fatalf("decodeDirectPreviewBoxID = %q, want %q", got, "abcdef0123456789")
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
