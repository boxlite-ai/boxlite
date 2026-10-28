// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"

	"github.com/boxlite-ai/proxy/cmd/proxy/config"
	"github.com/gin-gonic/gin"
)

const browserUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

// An access token proves nothing before the tunnel policy runs, and public
// tunnels ignore it, so it must not skip the anti-phishing page. Accepting
// the page returns to the token URL without putting the token in a query.
func TestAccessTokenKeepsWarningAndReturnsToTokenURL(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.Use((&Proxy{config: &config.Config{}}).browserWarningMiddleware())
	engine.Any("/*path", func(ctx *gin.Context) {
		if ctx.Request.URL.Path == ACCEPT_PREVIEW_PAGE_WARNING_PATH {
			handleAcceptProxyWarning(ctx, false)
			return
		}
		ctx.Status(http.StatusNoContent)
	})
	handler := sanitizeTunnelRequests(engine)
	host := "3000-d-416243644566313233343536.proxy.test"

	request := httptest.NewRequest(http.MethodGet, "http://"+host+"/app?"+accessTokenQuery+"=blt_visitor&x=1", nil)
	request.Header.Set("User-Agent", browserUserAgent)
	page := httptest.NewRecorder()
	handler.ServeHTTP(page, request)
	if page.Code == http.StatusNoContent {
		t.Fatal("access token skipped the browser warning page")
	}
	action := regexp.MustCompile(`<form action="([^"]*)"`).FindStringSubmatch(page.Body.String())
	field := regexp.MustCompile(`name="redirect" value="([^"]*)"`).FindStringSubmatch(page.Body.String())
	if action == nil || strings.Contains(action[1], "blt_visitor") || field == nil {
		t.Fatalf("warning form must carry the return URL in its body: %q", page.Body.String())
	}

	accept := httptest.NewRequest(http.MethodPost, "http://"+host+action[1], strings.NewReader(url.Values{"redirect": {unescapeHTML(field[1])}}.Encode()))
	accept.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	accept.Header.Set("User-Agent", browserUserAgent)
	accepted := httptest.NewRecorder()
	handler.ServeHTTP(accepted, accept)
	location, err := url.Parse(accepted.Header().Get("Location"))
	if accepted.Code != http.StatusFound || err != nil || location.Query().Get(accessTokenQuery) != "blt_visitor" || location.Query().Get("x") != "1" {
		t.Fatalf("accept redirected to %q (%d), want the token URL", accepted.Header().Get("Location"), accepted.Code)
	}
}

func unescapeHTML(value string) string {
	return strings.NewReplacer("&amp;", "&", "&#34;", `"`, "&#39;", "'", "&lt;", "<", "&gt;", ">").Replace(value)
}

// Behind a TLS-terminating load balancer the proxy listens in plain HTTP, but
// the browser is on HTTPS; the warning page must not send the token URL to
// http://.
func TestWarningPageUsesPublicSchemeBehindTLSTermination(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.Use((&Proxy{config: &config.Config{ProxyProtocol: "https", EnableTLS: false}}).browserWarningMiddleware())
	handler := sanitizeTunnelRequests(engine)
	host := "3000-d-416243644566313233343536.proxy.test"

	// A server request carries only the path in its URL, as a real one does.
	request := httptest.NewRequest(http.MethodGet, "/app?"+accessTokenQuery+"=blt_visitor", nil)
	request.Host = host
	request.Header.Set("User-Agent", browserUserAgent)
	page := httptest.NewRecorder()
	handler.ServeHTTP(page, request)
	field := regexp.MustCompile(`name="redirect" value="([^"]*)"`).FindStringSubmatch(page.Body.String())
	want := "https://" + host + "/app?" + accessTokenQuery + "=blt_visitor"
	if field == nil || unescapeHTML(field[1]) != want {
		t.Fatalf("warning page return URL = %v, want %q", field, want)
	}
	shown := regexp.MustCompile(`about to visit <strong>([^<]*)</strong>`).FindStringSubmatch(page.Body.String())
	if shown == nil || !strings.HasPrefix(shown[1], "https://"+host+"/") {
		t.Fatalf("warning page shows %v, want an https:// URL on %s", shown, host)
	}
}
