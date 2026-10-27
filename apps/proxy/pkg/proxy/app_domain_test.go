// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	common_cache "github.com/boxlite-ai/common-go/pkg/cache"
	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
	"github.com/boxlite-ai/proxy/cmd/proxy/config"
	"github.com/gin-gonic/gin"
)

const appDomain = "app.boxlite.test"

// newAppDomainProxy serves the API's domain lookup with one canned status and
// records the hostnames it was asked about. The legacy tunnel check answers
// 404 for everything, so a request that reaches it is a routing bug.
func newAppDomainProxy(t *testing.T, lookupStatus int) (*Proxy, *[]string) {
	t.Helper()
	var asked []string
	api := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if hostname, ok := trimPathPrefix(request.URL.Path, "/api/preview/domains/"); ok {
			asked = append(asked, hostname)
			writer.WriteHeader(lookupStatus)
			if lookupStatus == http.StatusOK {
				_ = json.NewEncoder(writer).Encode(map[string]any{"boxId": "AbCdEf123456", "port": 3000})
			}
			return
		}
		writer.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(api.Close)
	clientConfig := apiclient.NewConfiguration()
	clientConfig.Servers[0].URL = api.URL + "/api"
	clientConfig.AddDefaultHeader("Authorization", "Bearer proxy-key")
	ctx := context.Background()
	activityCache := common_cache.NewMapCache[bool](ctx)
	if err := activityCache.Set(ctx, "AbCdEf123456", true, time.Minute); err != nil {
		t.Fatal(err)
	}
	return &Proxy{
		apiclient:                  apiclient.NewAPIClient(clientConfig),
		config:                     &config.Config{ProxyAppDomain: appDomain, ProxyProtocol: "https"},
		boxInboundCache:            common_cache.NewMapCache[bool](ctx),
		boxAuthKeyValidCache:       common_cache.NewMapCache[bool](ctx),
		boxRunnerCache:             common_cache.NewMapCache[RunnerInfo](ctx),
		boxLastActivityUpdateCache: activityCache,
	}, &asked
}

func trimPathPrefix(path, prefix string) (string, bool) {
	if len(path) <= len(prefix) || path[:len(prefix)] != prefix {
		return "", false
	}
	return path[len(prefix):], true
}

func TestAppDomainHostClassification(t *testing.T) {
	proxy := &Proxy{config: &config.Config{ProxyAppDomain: appDomain}}
	for host, want := range map[string]string{
		"demo.app.boxlite.test":       "demo.app.boxlite.test",
		"Demo.APP.BoxLite.test:443":   "demo.app.boxlite.test",
		"demo.app.boxlite.test.":      "demo.app.boxlite.test",
		"3000-abc.app.boxlite.test":   "3000-abc.app.boxlite.test",
		"a.b.app.boxlite.test":        "a.b.app.boxlite.test",
		"app.boxlite.test":            "",
		"3000-abc.proxy.boxlite.test": "",
		"demo.app.boxlite.test.evil":  "",
	} {
		got, ok := proxy.appDomainHost(host)
		if ok != (want != "") || got != want {
			t.Errorf("appDomainHost(%q) = %q, %v; want %q", host, got, ok, want)
		}
	}
	if _, ok := (&Proxy{config: &config.Config{}}).appDomainHost("demo.app.boxlite.test"); ok {
		t.Fatal("an unset app domain classified a host as a platform subdomain")
	}
	// A local stack configures the port the proxy listens on; it is not part
	// of the hostname a name is bound under.
	local := &Proxy{config: &config.Config{ProxyAppDomain: "app.localhost:4000"}}
	if got, ok := local.appDomainHost("demo.app.localhost:4000"); !ok || got != "demo.app.localhost" {
		t.Fatalf("appDomainHost with a ported app domain = %q, %v", got, ok)
	}
}

func TestAppDomainHTTPForwardsToTheResolvedPort(t *testing.T) {
	proxy, asked := newAppDomainProxy(t, http.StatusOK)
	request := httptest.NewRequest(http.MethodGet, "http://Demo.app.boxlite.test:443/health?x=1", nil)
	request.Header.Set(platformAuthorizationHeader, "Bearer platform-key")
	request.Header.Set(accessTokenHeader, "blt_private-token")
	request.Header.Set("Authorization", "Bearer guest-key")
	request.AddCookie(&http.Cookie{Name: tunnelSessionCookie, Value: "platform-session"})
	request.AddCookie(&http.Cookie{Name: "guest-session", Value: "application-session"})
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = request

	target, err := proxy.GetProxyTarget(ctx)
	stopActivityPoll(ctx)
	if err != nil || target == nil {
		t.Fatalf("platform hostname was rejected: target=%v err=%v", target, err)
	}
	if target.URL.Host != "AbCdEf123456:3000" || target.URL.Path != "/health" {
		t.Fatalf("forwarded to %s, want the resolved box port and the user's path", target.URL)
	}
	if target.Headers["X-Forwarded-Host"] != "Demo.app.boxlite.test:443" || target.Headers["X-Forwarded-Proto"] != "https" {
		t.Fatalf("forwarded headers = %v", target.Headers)
	}
	if len(*asked) != 1 || (*asked)[0] != "demo.app.boxlite.test" {
		t.Fatalf("API asked for %v, want the lowercased hostname once", *asked)
	}
	if request.Header.Get(platformAuthorizationHeader) != "" || request.Header.Get(accessTokenHeader) != "" {
		t.Fatal("platform credentials reached the named-domain guest request")
	}
	if _, err := request.Cookie(tunnelSessionCookie); err != http.ErrNoCookie {
		t.Fatal("platform session cookie reached the named-domain guest request")
	}
	if request.Header.Get("Authorization") != "Bearer guest-key" || request.Header.Get("Cookie") != "guest-session=application-session" {
		t.Fatal("guest application credentials were removed")
	}
}

// `3000-abc.<app domain>` has the shape of a legacy `<port>-<box>` host. It is
// a platform name and goes to the API, never to the legacy parser.
func TestAppDomainPortShapedNameIsNotParsedAsLegacy(t *testing.T) {
	proxy, asked := newAppDomainProxy(t, http.StatusNotFound)
	request := httptest.NewRequest(http.MethodGet, "http://3000-abc.app.boxlite.test/", nil)
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = request

	target, err := proxy.GetProxyTarget(ctx)
	stopActivityPoll(ctx)
	if err == nil || target != nil {
		t.Fatalf("unknown platform name reached a target: target=%v err=%v", target, err)
	}
	if len(*asked) != 1 || (*asked)[0] != "3000-abc.app.boxlite.test" {
		t.Fatalf("API asked for %v, want the full platform hostname", *asked)
	}
	if len(ctx.Errors) != 1 || !isStatus(ctx.Errors[0].Err, http.StatusNotFound) {
		t.Fatalf("recorded %v, want 404", ctx.Errors)
	}
}

func TestAppDomainDeeperNameIs404WithoutAskingTheAPI(t *testing.T) {
	proxy, asked := newAppDomainProxy(t, http.StatusOK)
	request := httptest.NewRequest(http.MethodGet, "http://a.b.app.boxlite.test/", nil)
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = request

	if target, err := proxy.GetProxyTarget(ctx); err == nil || target != nil {
		t.Fatalf("deep name reached a target: target=%v err=%v", target, err)
	}
	if len(*asked) != 0 {
		t.Fatalf("API asked for %v, want nothing", *asked)
	}
	if len(ctx.Errors) != 1 || !isStatus(ctx.Errors[0].Err, http.StatusNotFound) {
		t.Fatalf("recorded %v, want 404", ctx.Errors)
	}
}

func TestAppDomainAPIFailureIsBadGatewayNotFallback(t *testing.T) {
	proxy, _ := newAppDomainProxy(t, http.StatusServiceUnavailable)
	request := httptest.NewRequest(http.MethodGet, "http://demo.app.boxlite.test/", nil)
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = request

	if target, err := proxy.GetProxyTarget(ctx); err == nil || target != nil {
		t.Fatalf("API failure reached a target: target=%v err=%v", target, err)
	}
	if len(ctx.Errors) != 1 || !isStatus(ctx.Errors[0].Err, http.StatusBadGateway) {
		t.Fatalf("recorded %v, want 502", ctx.Errors)
	}
}

// Inbound disabled, revoked and unbound all come back from the API as 404.
// The proxy neither signs the user in nor consults the legacy inbound check.
func TestAppDomainRefusalDoesNotRedirectToSignIn(t *testing.T) {
	proxy, _ := newAppDomainProxy(t, http.StatusNotFound)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "http://demo.app.boxlite.test/", nil)
	ctx, _ := gin.CreateTestContext(response)
	ctx.Request = request

	_, _ = proxy.GetProxyTarget(ctx)

	if response.Code == http.StatusFound || response.Header().Get("Location") != "" {
		t.Fatalf("platform hostname refusal redirected: %d %s", response.Code, response.Header().Get("Location"))
	}
}

func TestAppDomainConnectResolvesThroughTheAPI(t *testing.T) {
	proxy, asked := newAppDomainProxy(t, http.StatusNotFound)
	request := httptest.NewRequest(http.MethodConnect, "http://proxy.test", nil)
	request.Host = "demo.app.boxlite.test:443"
	response := httptest.NewRecorder()

	proxy.handleTunnelConnect(response, request)

	if response.Code != http.StatusNotFound {
		t.Fatalf("CONNECT on an unknown platform name = %d, want 404", response.Code)
	}
	if len(*asked) != 1 || (*asked)[0] != "demo.app.boxlite.test" {
		t.Fatalf("API asked for %v, want the hostname without its port", *asked)
	}
}

func TestAppDomainConnectAPIFailureIsBadGateway(t *testing.T) {
	proxy, _ := newAppDomainProxy(t, http.StatusServiceUnavailable)
	request := httptest.NewRequest(http.MethodConnect, "http://proxy.test", nil)
	request.Host = "demo.app.boxlite.test"
	response := httptest.NewRecorder()

	proxy.handleTunnelConnect(response, request)

	if response.Code != http.StatusBadGateway {
		t.Fatalf("CONNECT with the API down = %d, want 502", response.Code)
	}
}

// The proxy's own /health answers only on a Host that names no box; under a
// platform subdomain it is the user's service, resolved like any path.
func TestAppDomainHealthPathBelongsToTheUserService(t *testing.T) {
	gin.SetMode(gin.TestMode)
	proxy, asked := newAppDomainProxy(t, http.StatusNotFound)
	engine := gin.New()
	engine.Any("/*path", proxy.handleHTTP)

	for _, host := range []string{"demo.app.boxlite.test", "proxy.boxlite.test"} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, "http://"+host+"/health", nil)
		engine.ServeHTTP(response, request)
		if host == "proxy.boxlite.test" && response.Code != http.StatusOK {
			t.Fatalf("proxy's own /health = %d, want 200", response.Code)
		}
	}
	if len(*asked) != 1 || (*asked)[0] != "demo.app.boxlite.test" {
		t.Fatalf("API asked for %v, want the platform hostname's /health to be resolved", *asked)
	}
}

func TestAppDomainLoginPathsBelongToTheUserService(t *testing.T) {
	proxy, asked := newAppDomainProxy(t, http.StatusNotFound)
	engine := gin.New()
	engine.Any("/*path", proxy.handleHTTP)
	for _, path := range []string{"/login", "/callback", loginCallbackPath} {
		before := len(*asked)
		request := httptest.NewRequest(http.MethodGet, "https://demo.app.boxlite.test"+path, nil)
		engine.ServeHTTP(httptest.NewRecorder(), request)
		if len(*asked) != before+1 || (*asked)[before] != "demo.app.boxlite.test" {
			t.Fatalf("named domain path %s was intercepted by the proxy login flow", path)
		}
	}
}

func TestAppDomainGetsBrowserWarningEvenOnHealthPath(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.Use((&Proxy{config: &config.Config{ProxyAppDomain: appDomain}}).browserWarningMiddleware())
	engine.GET("/health", func(ctx *gin.Context) { ctx.Status(http.StatusNoContent) })
	request := httptest.NewRequest(http.MethodGet, "http://demo.app.boxlite.test/health", nil)
	request.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")
	response := httptest.NewRecorder()

	engine.ServeHTTP(response, request)

	if response.Code == http.StatusNoContent {
		t.Fatal("a platform subdomain's /health skipped the browser warning page")
	}
}

func TestAppDomainLookupIsNotCached(t *testing.T) {
	var status atomic.Int32
	status.Store(http.StatusOK)
	api := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(int(status.Load()))
		if status.Load() == http.StatusOK {
			_ = json.NewEncoder(writer).Encode(map[string]any{"boxId": "AbCdEf123456", "port": 3000})
		}
	}))
	t.Cleanup(api.Close)
	clientConfig := apiclient.NewConfiguration()
	clientConfig.Servers[0].URL = api.URL + "/api"
	clientConfig.AddDefaultHeader("Authorization", "Bearer proxy-key")
	proxy := &Proxy{apiclient: apiclient.NewAPIClient(clientConfig), config: &config.Config{ProxyAppDomain: appDomain}}

	if _, _, err := proxy.resolveAppDomain(context.Background(), "demo.app.boxlite.test"); err != nil {
		t.Fatalf("first lookup failed: %v", err)
	}
	status.Store(http.StatusNotFound)
	if _, _, err := proxy.resolveAppDomain(context.Background(), "demo.app.boxlite.test"); !errors.Is(err, errAppDomainNotFound) {
		t.Fatalf("second lookup after the name was released = %v, want not found", err)
	}
}

// The error middleware maps the common error types to statuses; a NotFoundError
// carries none itself.
func isStatus(err error, status int) bool {
	var custom *common_errors.CustomError
	if errors.As(err, &custom) {
		return custom.StatusCode == status
	}
	var notFound *common_errors.NotFoundError
	return errors.As(err, &notFound) && status == http.StatusNotFound
}
