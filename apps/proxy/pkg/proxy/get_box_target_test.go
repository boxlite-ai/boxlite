// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	common_cache "github.com/boxlite-ai/common-go/pkg/cache"
	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
	"github.com/gin-gonic/gin"
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

func TestDecodeDirectPreviewBoxID(t *testing.T) {
	got, ok, err := decodeDirectPreviewBoxID("d-35334d4f5a336a70355a7531")
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
	_, ok, err := decodeDirectPreviewBoxID("d-35334d4f5a336a702f2e2e2f")
	if err == nil {
		t.Fatal("decodeDirectPreviewBoxID returned nil error")
	}
	if !ok {
		t.Fatal("decodeDirectPreviewBoxID did not recognize encoded direct box ID")
	}
}

func TestDecodeDirectPreviewBoxIDRejectsDecodedWrongLength(t *testing.T) {
	_, ok, err := decodeDirectPreviewBoxID("d-35334d4f5a336a70355a75")
	if err == nil {
		t.Fatal("decodeDirectPreviewBoxID returned nil error")
	}
	if !ok {
		t.Fatal("decodeDirectPreviewBoxID did not recognize prefixed direct box ID")
	}

	_, ok, err = decodeDirectPreviewBoxID("d-35334d4f5a336a70355a7500")
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

func TestDecodeDirectPreviewBoxIDKeepsShortRawValue(t *testing.T) {
	got, ok, err := decodeDirectPreviewBoxID("abcdef0123456789")
	if err != nil {
		t.Fatalf("decodeDirectPreviewBoxID returned error: %v", err)
	}
	if ok {
		t.Fatal("decodeDirectPreviewBoxID unexpectedly recognized short raw value")
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

func TestGetProxyTargetReportsOutOfRangePublicPortAsBadRequest(t *testing.T) {
	cacheContext := context.Background()
	publicCache := common_cache.NewMapCache[bool](cacheContext)
	activityCache := common_cache.NewMapCache[bool](cacheContext)
	boxID := "53MOZ3jp5Zu1"
	if err := publicCache.Set(cacheContext, boxID, true, time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := activityCache.Set(cacheContext, boxID, true, time.Minute); err != nil {
		t.Fatal(err)
	}

	proxy := &Proxy{
		boxPublicCache:             publicCache,
		boxLastActivityUpdateCache: activityCache,
	}
	request := httptest.NewRequest(http.MethodGet, "http://proxy.test/", nil)
	request.Host = "70000-d-35334d4f5a336a70355a7531.proxy.test"
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = request

	target, err := proxy.GetProxyTarget(ctx)
	stopActivityPoll(ctx)
	if err == nil || target != nil {
		t.Fatalf("GetProxyTarget() = %#v, %v; want nil target and an error", target, err)
	}
	if len(ctx.Errors) != 1 {
		t.Fatalf("context errors = %d, want 1", len(ctx.Errors))
	}
	if _, ok := ctx.Errors.Last().Err.(*common_errors.BadRequestError); !ok {
		t.Fatalf("context error = %T, want *errors.BadRequestError", ctx.Errors.Last().Err)
	}
}

func TestGuestPortTransportCarriesHTTPOverRunnerConnect(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	serverResult := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			serverResult <- err
			return
		}
		defer conn.Close()
		reader := bufio.NewReader(conn)

		connectRequest, err := http.ReadRequest(reader)
		if err != nil {
			serverResult <- err
			return
		}
		if connectRequest.Method != http.MethodConnect || connectRequest.URL.Path != "/v1/boxes/AbCdEf123456/network/tunnel" || connectRequest.URL.Query().Get("port") != "3000" {
			serverResult <- fmt.Errorf("unexpected CONNECT request: %s %s", connectRequest.Method, connectRequest.URL.String())
			return
		}
		if got := connectRequest.Header.Get("X-BoxLite-Authorization"); got != "Bearer runner-key" {
			serverResult <- fmt.Errorf("runner authorization = %q", got)
			return
		}
		if _, err := io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
			serverResult <- err
			return
		}

		guestRequest, err := http.ReadRequest(reader)
		if err != nil {
			serverResult <- err
			return
		}
		if guestRequest.URL.RequestURI() != "/hello?value=ok" || guestRequest.Host != "3000-d-box.proxy.test" {
			serverResult <- fmt.Errorf("unexpected guest request: host=%q uri=%q", guestRequest.Host, guestRequest.URL.RequestURI())
			return
		}
		_, err = io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 13\r\nConnection: close\r\n\r\nthrough-l4-ok")
		serverResult <- err
	}()

	ctx := context.Background()
	runnerCache := common_cache.NewMapCache[RunnerInfo](ctx)
	if err := runnerCache.Set(ctx, "AbCdEf123456", RunnerInfo{ApiUrl: "http://" + listener.Addr().String(), ApiKey: "runner-key"}, time.Minute); err != nil {
		t.Fatal(err)
	}
	proxy := &Proxy{boxRunnerCache: runnerCache}
	client := &http.Client{Transport: proxy.newGuestPortTransport(), Timeout: 3 * time.Second}
	request, err := http.NewRequest(http.MethodGet, "http://AbCdEf123456:3000/hello?value=ok", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Host = "3000-d-box.proxy.test"
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || string(body) != "through-l4-ok" {
		t.Fatalf("response = %d %q", response.StatusCode, body)
	}
	if err := <-serverResult; err != nil {
		t.Fatal(err)
	}
}

func TestActivityPollControllerStopIsIdempotent(t *testing.T) {
	controller := newActivityPollController()
	controller.stop()
	controller.stop()

	select {
	case <-controller.done:
	default:
		t.Fatal("activity poll was not stopped")
	}
}
