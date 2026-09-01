// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	common_cache "github.com/boxlite-ai/common-go/pkg/cache"
	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
	"github.com/gin-gonic/gin"
)

type failingSetCache[T any] struct{}

func (failingSetCache[T]) Get(context.Context, string) (*T, error) {
	return nil, errors.New("cache miss")
}

func (failingSetCache[T]) Set(context.Context, string, T, time.Duration) error {
	return errors.New("cache unavailable")
}

func (failingSetCache[T]) Delete(context.Context, string) error {
	return nil
}

func (failingSetCache[T]) Has(context.Context, string) (bool, error) {
	return false, nil
}

func TestCacheErrorsDoNotLogPreviewCredentials(t *testing.T) {
	previousLogger := slog.Default()
	var output bytes.Buffer
	slog.SetDefault(slog.New(slog.NewTextHandler(&output, nil)))
	defer slog.SetDefault(previousLogger)

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte("true"))
	}))
	defer server.Close()

	clientConfig := apiclient.NewConfiguration()
	clientConfig.Servers[0].URL = server.URL
	proxy := &Proxy{
		apiclient:            apiclient.NewAPIClient(clientConfig),
		boxPublicCache:       failingSetCache[bool]{},
		boxAuthKeyValidCache: failingSetCache[bool]{},
	}
	signedToken := "signed-preview-token-secret"
	authKey := "auth-key-secret"

	if _, err := proxy.getBoxPublic(context.Background(), signedToken); err != nil {
		t.Fatalf("getBoxPublic() error = %v", err)
	}
	// A rejection, because only rejections are cached -- an acceptance never reaches
	// the failing Set and so would never produce the log line asserted below.
	if _, err := proxy.validateAndCache(context.Background(), signedToken, authKey, func() (bool, error) {
		return false, nil
	}); err != nil {
		t.Fatalf("validateAndCache() error = %v", err)
	}

	logs := output.String()
	for _, secret := range []string{signedToken, authKey} {
		if strings.Contains(logs, secret) {
			t.Errorf("cache error log contains preview credential %q", secret)
		}
	}
	for _, message := range []string{"Failed to set box public in cache", "Failed to set box auth key valid in cache"} {
		if !strings.Contains(logs, message) {
			t.Errorf("cache error log does not contain %q", message)
		}
	}
}

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

type recordedCacheWrite struct {
	key string
	ttl time.Duration
}

type recordingCache[T any] struct {
	writes []recordedCacheWrite
}

func (*recordingCache[T]) Get(context.Context, string) (*T, error) {
	return nil, errors.New("cache miss")
}

func (c *recordingCache[T]) Set(_ context.Context, key string, _ T, ttl time.Duration) error {
	c.writes = append(c.writes, recordedCacheWrite{key: key, ttl: ttl})
	return nil
}

func (*recordingCache[T]) Delete(context.Context, string) error {
	return nil
}

func (*recordingCache[T]) Has(context.Context, string) (bool, error) {
	return false, nil
}

func cacheAuthResult(t *testing.T, isValid bool) []recordedCacheWrite {
	t.Helper()

	cache := &recordingCache[bool]{}
	proxy := &Proxy{boxAuthKeyValidCache: cache}

	if _, err := proxy.validateAndCache(context.Background(), "AbCdEf123456", "blk_live_secret", func() (bool, error) {
		return isValid, nil
	}); err != nil {
		t.Fatalf("validateAndCache() error = %v", err)
	}

	return cache.writes
}

// A cached acceptance is what a revoked credential rides on: nothing evicts the
// entry, and in production config.Redis is nil so the cache is in-process and the
// API cannot reach it either. Any TTL at all reopens the window the API closes on
// delete, so the acceptance is not cached at any TTL.
func TestValidAuthResultIsNotCached(t *testing.T) {
	writes := cacheAuthResult(t, true)

	for _, write := range writes {
		t.Errorf("valid auth result cached under %q for %v, want no cache write", write.key, write.ttl)
	}
}

func TestInvalidAuthResultIsCached(t *testing.T) {
	// Revocation latency no longer rides on this cache at all, so shortening the
	// rejection TTL buys nothing and only sends repeated bad credentials back to the
	// API more often. It stays at the two minutes both verdicts shared before.
	const wantTTL = 2 * time.Minute

	writes := cacheAuthResult(t, false)

	if len(writes) != 1 {
		t.Fatalf("invalid auth result made %d cache writes, want 1", len(writes))
	}
	if writes[0].ttl != wantTTL {
		t.Errorf("invalid auth result cached for %v, want %v", writes[0].ttl, wantTTL)
	}
}

// The acceptance is re-derived from the API on every request -- that, not a TTL, is
// what bounds how long a deleted credential keeps reaching the box.
func TestValidAuthResultIsRevalidatedOnEveryRequest(t *testing.T) {
	ctx := context.Background()
	proxy := &Proxy{boxAuthKeyValidCache: common_cache.NewMapCache[bool](ctx)}

	validations := 0
	validate := func() (bool, error) {
		validations++
		return true, nil
	}

	for attempt := 1; attempt <= 2; attempt++ {
		isValid, err := proxy.validateAndCache(ctx, "AbCdEf123456", "blk_live_secret", validate)
		if err != nil {
			t.Fatalf("validateAndCache() attempt %d error = %v", attempt, err)
		}
		if !*isValid {
			t.Fatalf("validateAndCache() attempt %d = false, want true", attempt)
		}
		if validations != attempt {
			t.Fatalf("validateAndCache() reached the API %d times after %d calls, want %d", validations, attempt, attempt)
		}
	}
}

// The rejection is still cached, so a credential the API has already refused does
// not get to spend an API round trip on every retry.
func TestCachedInvalidAuthResultIsServedWithoutRevalidating(t *testing.T) {
	ctx := context.Background()
	proxy := &Proxy{boxAuthKeyValidCache: common_cache.NewMapCache[bool](ctx)}

	validations := 0
	validate := func() (bool, error) {
		validations++
		return false, nil
	}
	if _, err := proxy.validateAndCache(ctx, "AbCdEf123456", "blk_live_secret", validate); err != nil {
		t.Fatalf("validateAndCache() error = %v", err)
	}

	isValid, err := proxy.validateAndCache(ctx, "AbCdEf123456", "blk_live_secret", validate)
	if err != nil {
		t.Fatalf("validateAndCache() error = %v", err)
	}

	if validations != 1 {
		t.Errorf("validateAndCache() reached the API %d times, want 1 -- the second call should be cached", validations)
	}
	if *isValid {
		t.Error("validateAndCache() = true, want the cached rejection")
	}
}
