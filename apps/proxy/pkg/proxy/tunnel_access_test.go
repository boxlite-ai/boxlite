// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	common_cache "github.com/boxlite-ai/common-go/pkg/cache"
	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
	"github.com/boxlite-ai/proxy/cmd/proxy/config"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/securecookie"
)

func newTunnelProxy(t *testing.T, accessStatus int) *Proxy {
	t.Helper()
	api := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if strings.HasPrefix(request.URL.Path, "/api/preview/AbCdEf123456/tunnels/") {
			writer.WriteHeader(accessStatus)
			return
		}
		writer.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(api.Close)
	clientConfig := apiclient.NewConfiguration()
	clientConfig.Servers[0].URL = api.URL + "/api"
	clientConfig.AddDefaultHeader("Authorization", "Bearer proxy-key")
	ctx := context.Background()
	publicCache := common_cache.NewMapCache[bool](ctx)
	if err := publicCache.Set(ctx, "AbCdEf123456", true, time.Minute); err != nil {
		t.Fatal(err)
	}
	activityCache := common_cache.NewMapCache[bool](ctx)
	if err := activityCache.Set(ctx, "AbCdEf123456", true, time.Minute); err != nil {
		t.Fatal(err)
	}
	runnerCache := common_cache.NewMapCache[RunnerInfo](ctx)
	if err := runnerCache.Set(ctx, "AbCdEf123456", RunnerInfo{ApiUrl: "http://127.0.0.1:1", ApiKey: "runner-key"}, time.Minute); err != nil {
		t.Fatal(err)
	}
	proxy := &Proxy{
		apiclient:                  apiclient.NewAPIClient(clientConfig),
		config:                     &config.Config{},
		boxInboundCache:            publicCache,
		boxAuthKeyValidCache:       common_cache.NewMapCache[bool](ctx),
		boxRunnerCache:             runnerCache,
		boxLastActivityUpdateCache: activityCache,
	}
	return proxy
}

func TestUndeclaredTunnelRejectsHTTP(t *testing.T) {
	proxy := newTunnelProxy(t, http.StatusNotFound)
	request := httptest.NewRequest(http.MethodGet, "http://3000-d-416243644566313233343536.proxy.test/", nil)
	response := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(response)
	ctx.Request = request

	target, err := proxy.GetProxyTarget(ctx)
	stopActivityPoll(ctx)
	if err == nil || target != nil {
		t.Fatalf("undeclared HTTP port reached proxy target: target=%v err=%v", target, err)
	}
	if _, started := ctx.Get(ACTIVITY_POLL_STOP_KEY); started {
		t.Fatal("undeclared HTTP port started activity polling")
	}
}

func TestUndeclaredTunnelRejectsConnect(t *testing.T) {
	proxy := newTunnelProxy(t, http.StatusNotFound)
	request := httptest.NewRequest(http.MethodConnect, "http://proxy.test", nil)
	request.Host = "3000-d-416243644566313233343536.proxy.test:443"
	response := httptest.NewRecorder()

	proxy.handleTunnelConnect(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("undeclared CONNECT port status = %d, want 404", response.Code)
	}
}

func TestUndeclaredTunnelRejectsRawBoxIDHost(t *testing.T) {
	proxy := newTunnelProxy(t, http.StatusNotFound)
	request := httptest.NewRequest(http.MethodGet, "http://3000-AbCdEf123456.proxy.test/", nil)
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = request

	target, err := proxy.GetProxyTarget(ctx)
	stopActivityPoll(ctx)
	if err == nil || target != nil {
		t.Fatalf("raw box ID host bypassed declaration: target=%v err=%v", target, err)
	}
}

func TestDeclaredTunnelAllowsHTTP(t *testing.T) {
	proxy := newTunnelProxy(t, http.StatusOK)
	request := httptest.NewRequest(http.MethodGet, "http://3000-d-416243644566313233343536.proxy.test/", nil)
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = request

	target, err := proxy.GetProxyTarget(ctx)
	stopActivityPoll(ctx)
	if err != nil || target == nil {
		t.Fatalf("declared HTTP port was rejected: target=%v err=%v", target, err)
	}
}

func TestAuthenticatedPrivateServicePreviewIsDenied(t *testing.T) {
	proxy := newTunnelProxy(t, http.StatusNotFound)
	ctx := context.Background()
	if err := proxy.boxInboundCache.Set(ctx, "AbCdEf123456", false, time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := proxy.boxAuthKeyValidCache.Set(ctx, "AbCdEf123456:owner-key", true, time.Minute); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "http://3000-d-416243644566313233343536.proxy.test/", nil)
	request.Header.Set("Authorization", "Bearer owner-key")
	ginCtx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ginCtx.Request = request

	target, err := proxy.GetProxyTarget(ginCtx)
	stopActivityPoll(ginCtx)
	if err == nil || target != nil {
		t.Fatalf("private service preview reached guest port: target=%v err=%v", target, err)
	}
}

func TestSignInCookieServicePreviewRequiresTunnel(t *testing.T) {
	for _, test := range []struct {
		name         string
		accessStatus int
		allowed      bool
	}{
		{name: "undeclared", accessStatus: http.StatusNotFound},
		{name: "declared", accessStatus: http.StatusOK, allowed: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			proxy := newTunnelProxy(t, test.accessStatus)
			proxy.config = &config.Config{}
			proxy.secureCookie = securecookie.New([]byte("test-cookie-signing-key-with-32-bytes"), nil)
			if err := proxy.boxInboundCache.Set(context.Background(), "AbCdEf123456", false, time.Minute); err != nil {
				t.Fatal(err)
			}
			cookieValue, err := proxy.secureCookie.Encode(BOX_AUTH_COOKIE_NAME+"AbCdEf123456", "AbCdEf123456")
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodGet, "http://3000-d-416243644566313233343536.proxy.test/", nil)
			request.AddCookie(&http.Cookie{Name: BOX_AUTH_COOKIE_NAME + "AbCdEf123456", Value: cookieValue})
			ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
			ctx.Request = request

			target, err := proxy.GetProxyTarget(ctx)
			stopActivityPoll(ctx)
			if (err == nil && target != nil) != test.allowed {
				t.Fatalf("signed-in preview allowed = %t, want %t (target=%v, err=%v)", err == nil && target != nil, test.allowed, target, err)
			}
		})
	}
}

func TestPrivatePort22222IsDeniedLikeAnyPort(t *testing.T) {
	proxy := newTunnelProxy(t, http.StatusNotFound)
	ctx := context.Background()
	if err := proxy.boxInboundCache.Set(ctx, "AbCdEf123456", false, time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := proxy.boxAuthKeyValidCache.Set(ctx, "AbCdEf123456:owner-key", true, time.Minute); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "http://22222-AbCdEf123456.proxy.test/", nil)
	request.Header.Set("Authorization", "Bearer owner-key")
	ginCtx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ginCtx.Request = request

	target, err := proxy.GetProxyTarget(ginCtx)
	stopActivityPoll(ginCtx)
	if err == nil || target != nil {
		t.Fatalf("private port 22222 reached a target: target=%v err=%v", target, err)
	}
}

func TestFailedSignInDoesNotResolveHostAsSignedToken(t *testing.T) {
	var tokenLookups atomic.Int32
	api := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if strings.HasSuffix(request.URL.Path, "/box-id") {
			tokenLookups.Add(1)
		}
		writer.WriteHeader(http.StatusNotFound)
	}))
	defer api.Close()
	clientConfig := apiclient.NewConfiguration()
	clientConfig.Servers[0].URL = api.URL + "/api"
	ctx := context.Background()
	inboundCache := common_cache.NewMapCache[bool](ctx)
	if err := inboundCache.Set(ctx, "AbCdEf123456", false, time.Minute); err != nil {
		t.Fatal(err)
	}
	proxy := &Proxy{
		apiclient:       apiclient.NewAPIClient(clientConfig),
		config:          &config.Config{},
		boxInboundCache: inboundCache,
	}
	request := httptest.NewRequest(http.MethodGet, "http://3000-d-416243644566313233343536.proxy.test/", nil)
	ginCtx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ginCtx.Request = request

	target, err := proxy.GetProxyTarget(ginCtx)
	stopActivityPoll(ginCtx)
	if err == nil || target != nil {
		t.Fatalf("unauthenticated private box reached a target: target=%v err=%v", target, err)
	}
	if n := tokenLookups.Load(); n != 0 {
		t.Fatalf("proxy asked the API to resolve the host as a signed token %d times", n)
	}
}

func TestTunnelAccessAPIErrorFailsHTTPWithBadGateway(t *testing.T) {
	proxy := newTunnelProxy(t, http.StatusServiceUnavailable)
	request := httptest.NewRequest(http.MethodGet, "http://3000-d-416243644566313233343536.proxy.test/", nil)
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = request

	target, err := proxy.GetProxyTarget(ctx)
	stopActivityPoll(ctx)
	if err == nil || target != nil {
		t.Fatalf("access API failure reached proxy target: target=%v err=%v", target, err)
	}
	var customErr *common_errors.CustomError
	if len(ctx.Errors) != 1 || !errors.As(ctx.Errors[0].Err, &customErr) || customErr.StatusCode != http.StatusBadGateway {
		t.Fatalf("access API failure recorded %v, want 502", ctx.Errors)
	}
}

func TestTunnelAccessAPIErrorFailsConnectWithBadGateway(t *testing.T) {
	proxy := newTunnelProxy(t, http.StatusServiceUnavailable)
	request := httptest.NewRequest(http.MethodConnect, "http://proxy.test", nil)
	request.Host = "3000-d-416243644566313233343536.proxy.test:443"
	response := httptest.NewRecorder()

	proxy.handleTunnelConnect(response, request)
	if response.Code != http.StatusBadGateway {
		t.Fatalf("access API failure status = %d, want 502", response.Code)
	}
}

func TestProxyDoesNotCacheTunnelAccess(t *testing.T) {
	var status atomic.Int32
	status.Store(http.StatusOK)
	api := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(int(status.Load()))
	}))
	defer api.Close()
	config := apiclient.NewConfiguration()
	config.Servers[0].URL = api.URL + "/api"
	proxy := &Proxy{apiclient: apiclient.NewAPIClient(config)}

	allowed, err := proxy.hasPublicTunnelAccess(context.Background(), "AbCdEf123456", 3000)
	if err != nil || !allowed {
		t.Fatalf("declared port rejected: allowed=%v err=%v", allowed, err)
	}
	status.Store(http.StatusNotFound)
	allowed, err = proxy.hasPublicTunnelAccess(context.Background(), "AbCdEf123456", 3000)
	if err != nil || allowed {
		t.Fatalf("revoked port remained authorized: allowed=%v err=%v", allowed, err)
	}
}

// No API route hands out the box auth token any more, so the proxy no longer
// treats the preview-token header or query parameter as a credential.
func TestPreviewTokenIsNotValidatedWithTheAPI(t *testing.T) {
	var tokenValidations atomic.Int32
	api := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if strings.Contains(request.URL.Path, "/validate/") {
			tokenValidations.Add(1)
		}
		writer.WriteHeader(http.StatusNotFound)
	}))
	defer api.Close()
	clientConfig := apiclient.NewConfiguration()
	clientConfig.Servers[0].URL = api.URL + "/api"
	ctx := context.Background()
	inboundCache := common_cache.NewMapCache[bool](ctx)
	if err := inboundCache.Set(ctx, "AbCdEf123456", false, time.Minute); err != nil {
		t.Fatal(err)
	}
	proxy := &Proxy{
		apiclient:            apiclient.NewAPIClient(clientConfig),
		config:               &config.Config{},
		boxInboundCache:      inboundCache,
		boxAuthKeyValidCache: common_cache.NewMapCache[bool](ctx),
	}
	request := httptest.NewRequest(http.MethodGet, "http://3000-d-416243644566313233343536.proxy.test/?BOXLITE_BOX_AUTH_KEY=owner-key", nil)
	request.Header.Set("X-BoxLite-Preview-Token", "owner-key")
	ginCtx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ginCtx.Request = request

	target, err := proxy.GetProxyTarget(ginCtx)
	stopActivityPoll(ginCtx)
	if err == nil || target != nil {
		t.Fatalf("preview token reached a target: target=%v err=%v", target, err)
	}
	if n := tokenValidations.Load(); n != 0 {
		t.Fatalf("proxy validated the preview token with the API %d times", n)
	}
}
