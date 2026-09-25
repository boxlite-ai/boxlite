// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	common_cache "github.com/boxlite-ai/common-go/pkg/cache"
	"github.com/gin-gonic/gin"
)

func newTunnelProxy(t *testing.T, accessStatus int) (*Proxy, func()) {
	t.Helper()
	api := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/preview/AbCdEf123456/tunnels/3000" {
			writer.WriteHeader(accessStatus)
			return
		}
		writer.WriteHeader(http.StatusNotFound)
	}))
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
		boxRunnerCache:             runnerCache,
		boxLastActivityUpdateCache: activityCache,
	}
	return proxy, api.Close
}

func TestUndeclaredTunnelRejectsHTTP(t *testing.T) {
	proxy, closeAPI := newTunnelProxy(t, http.StatusNotFound)
	defer closeAPI()
	request := httptest.NewRequest(http.MethodGet, "http://3000-d-416243644566313233343536.proxy.test/", nil)
	response := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(response)
	ctx.Request = request

	target, err := proxy.GetProxyTarget(ctx)
	stopActivityPoll(ctx)
	if err == nil || target != nil {
		t.Fatalf("undeclared HTTP port reached proxy target: target=%v err=%v", target, err)
	}
}

func TestUndeclaredTunnelRejectsConnect(t *testing.T) {
	proxy, closeAPI := newTunnelProxy(t, http.StatusNotFound)
	defer closeAPI()
	request := httptest.NewRequest(http.MethodConnect, "http://proxy.test", nil)
	request.Host = "3000-d-416243644566313233343536.proxy.test:443"
	response := httptest.NewRecorder()

	proxy.handleTunnelConnect(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("undeclared CONNECT port status = %d, want 404", response.Code)
	}
}

func TestUndeclaredTunnelRejectsRawBoxIDHost(t *testing.T) {
	proxy, closeAPI := newTunnelProxy(t, http.StatusNotFound)
	defer closeAPI()
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
	proxy, closeAPI := newTunnelProxy(t, http.StatusOK)
	defer closeAPI()
	request := httptest.NewRequest(http.MethodGet, "http://3000-d-416243644566313233343536.proxy.test/", nil)
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = request

	target, err := proxy.GetProxyTarget(ctx)
	stopActivityPoll(ctx)
	if err != nil || target == nil {
		t.Fatalf("declared HTTP port was rejected: target=%v err=%v", target, err)
	}
}

func TestTunnelAccessAPIErrorFailsClosed(t *testing.T) {
	proxy, closeAPI := newTunnelProxy(t, http.StatusServiceUnavailable)
	defer closeAPI()
	request := httptest.NewRequest(http.MethodConnect, "http://proxy.test", nil)
	request.Host = "3000-d-416243644566313233343536.proxy.test:443"
	response := httptest.NewRecorder()

	proxy.handleTunnelConnect(response, request)
	if response.Code != http.StatusBadGateway {
		t.Fatalf("access API failure status = %d, want 502", response.Code)
	}
}
