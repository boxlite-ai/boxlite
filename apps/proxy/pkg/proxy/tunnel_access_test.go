// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	common_cache "github.com/boxlite-ai/common-go/pkg/cache"
	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
	"github.com/gin-gonic/gin"
)

func newTunnelProxy(t *testing.T, accessStatus int) *Proxy {
	t.Helper()
	api := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/preview/AbCdEf123456/tunnels/3000" {
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
		boxPublicCache:             publicCache,
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

func TestAuthenticatedPrivatePreviewKeepsWorking(t *testing.T) {
	proxy := newTunnelProxy(t, http.StatusNotFound)
	ctx := context.Background()
	if err := proxy.boxPublicCache.Set(ctx, "AbCdEf123456", false, time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := proxy.boxAuthKeyValidCache.Set(ctx, "AbCdEf123456:owner-key", true, time.Minute); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "http://3000-d-416243644566313233343536.proxy.test/", nil)
	request.Header.Set(BOX_AUTH_KEY_HEADER, "owner-key")
	ginCtx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ginCtx.Request = request

	target, err := proxy.GetProxyTarget(ginCtx)
	stopActivityPoll(ginCtx)
	if err != nil || target == nil {
		t.Fatalf("authenticated private preview rejected: target=%v err=%v", target, err)
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
