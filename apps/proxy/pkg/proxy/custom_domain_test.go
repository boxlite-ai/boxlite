// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestCustomDomainNeverFallsBackToGeneratedTunnel(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodConnect} {
		for _, host := range []string{"app.customer.com", "3000-AbCdEf123456.customer.com"} {
			t.Run(method+"/"+host, func(t *testing.T) {
				proxy, asked := newAppDomainProxy(t, http.StatusNotFound)
				// JSON also works against the old configuration type, so this regression
				// reaches the routing assertion when every production change is reverted.
				if err := json.Unmarshal([]byte(`{"ProxyDomain":"proxy.boxlite.test","CustomDomainsEnabled":true}`), proxy.config); err != nil {
					t.Fatal(err)
				}
				recorder := httptest.NewRecorder()
				request := httptest.NewRequest(method, "https://"+host+"/health", nil)
				request.Host = host
				if method == http.MethodConnect {
					if _, _, admitted := proxy.admitTunnelConnect(recorder, request); admitted {
						t.Fatal("unowned custom host admitted")
					}
				} else {
					ctx, _ := gin.CreateTestContext(recorder)
					ctx.Request = request
					proxy.handleHTTP(ctx)
				}
				if len(*asked) != 1 || (*asked)[0] != strings.ToLower(host) {
					t.Fatalf("domain lookups = %v; want exact %s", *asked, host)
				}
			})
		}
	}
}

func TestCustomDomainUsesExactResolvedTarget(t *testing.T) {
	for _, websocket := range []bool{false, true} {
		proxy, asked := newAppDomainProxy(t, http.StatusOK)
		if err := json.Unmarshal([]byte(`{"ProxyDomain":"proxy.boxlite.test","CustomDomainsEnabled":true}`), proxy.config); err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest(http.MethodGet, "https://a.b.customer.com/health?x=1", nil)
		request.Header.Set(platformAuthorizationHeader, "Bearer platform-key")
		if websocket {
			request.Header.Set("Upgrade", "websocket")
			request.Header.Set("Connection", "Upgrade")
		}
		ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
		ctx.Request = request
		target, err := proxy.GetProxyTarget(ctx)
		stopActivityPoll(ctx)
		if err != nil || target == nil {
			t.Fatalf("custom domain rejected: %v", err)
		}
		if target.URL.Host != "AbCdEf123456:3000" || target.URL.Path != "/health" {
			t.Fatalf("wrong target: %s", target.URL)
		}
		if len(*asked) != 1 || (*asked)[0] != "a.b.customer.com" {
			t.Fatalf("lookups: %v", *asked)
		}
		if request.Header.Get(platformAuthorizationHeader) != "" {
			t.Fatal("platform credentials reached customer service")
		}
	}
}
