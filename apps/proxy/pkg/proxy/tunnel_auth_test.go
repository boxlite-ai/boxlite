// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

const privateTestURL = "https://3000-d-416243644566313233343536.proxy.test/"
const privateTestToken = "blt_test-external-token"

func privateAuthProxy(t *testing.T) (*Proxy, *tunnelGrant) {
	t.Helper()
	return privateAuthProxyWithMembers(t, nil)
}

// privateAuthProxyWithMembers fakes an API that admits a browser user only
// while members lists them; nil members admits every user.
func privateAuthProxyWithMembers(t *testing.T, members map[string]bool) (*Proxy, *tunnelGrant) {
	t.Helper()
	grant := &tunnelGrant{ID: "tunnel-private", BoxID: "AbCdEf123456", Port: 3000, Generation: 1}
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/access") && r.Method == http.MethodGet {
			if r.Header.Get("X-Forwarded-For") == "" {
				t.Error("visitor IP missing from platform credential check")
			}
			if r.Header.Get("Authorization") != "Bearer owner-key" {
				w.WriteHeader(404)
				return
			}
			_, _ = w.Write([]byte("true"))
			return
		}
		if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/tunnels/3000/access") {
			w.WriteHeader(404)
			return
		}
		var body struct {
			Token  *string `json:"token"`
			UserID string  `json:"userId"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			w.WriteHeader(400)
			return
		}
		if grant.Generation == 0 {
			w.WriteHeader(404)
			return
		}
		if body.UserID != "" && members != nil && !members[body.UserID] {
			w.WriteHeader(403)
			return
		}
		if body.Token != nil && !grant.IsPublic && *body.Token != privateTestToken {
			w.WriteHeader(403)
			return
		}
		_ = json.NewEncoder(w).Encode(grant)
	}))
	t.Cleanup(api.Close)
	proxy := newTunnelProxy(t, http.StatusOK)
	cfg := apiclient.NewConfiguration()
	cfg.Servers[0].URL = api.URL
	proxy.apiclient = apiclient.NewAPIClient(cfg)
	proxy.config.ProxyApiKey = "proxy-test-signing-key-with-32-bytes"
	proxy.config.ProxyProtocol = "https"
	return proxy, grant
}

func tokenSession(t *testing.T, p *Proxy) *http.Cookie {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, privateTestURL+"?"+accessTokenQuery+"="+privateTestToken+"&app=a%20b", nil)
	r.Header.Set("Authorization", "Bearer guest-application-token")
	w := httptest.NewRecorder()
	if err := p.authorizeTunnel(w, r, "AbCdEf123456", 3000); err != nil {
		t.Fatal(err)
	}
	if r.URL.RawQuery != "app=a%20b" || strings.Contains(r.RequestURI, privateTestToken) {
		t.Fatal("token reached guest URL")
	}
	if r.Header.Get("Authorization") != "Bearer guest-application-token" {
		t.Fatal("application credential was consumed")
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("session cookies = %v", cookies)
	}
	cookie := cookies[0]
	if cookie.Name != tunnelSessionCookie || cookie.Domain != "" || cookie.Path != "/" || !cookie.Secure || !cookie.HttpOnly || cookie.MaxAge != 3600 || cookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("unsafe session attributes: %v", cookie)
	}
	return cookie
}

func TestPrivateTunnelSessionScopeRenewalAndRevocation(t *testing.T) {
	p, grant := privateAuthProxy(t)
	cookie := tokenSession(t, p)
	request := func() *http.Request {
		r := httptest.NewRequest(http.MethodGet, privateTestURL, nil)
		r.AddCookie(cookie)
		return r
	}
	w := httptest.NewRecorder()
	r := request()
	r.AddCookie(&http.Cookie{Name: "app_session", Value: "keep"})
	if err := p.authorizeTunnel(w, r, grant.BoxID, grant.Port); err != nil {
		t.Fatal(err)
	}
	if len(w.Result().Cookies()) != 0 {
		t.Fatal("fresh session was unnecessarily renewed")
	}
	if r.Header.Get("Cookie") != "app_session=keep" {
		t.Fatal("platform cookie reached guest")
	}
	var session tunnelSession
	if err := p.sessionCodec().Decode(tunnelSessionCookie, cookie.Value, &session); err != nil {
		t.Fatal(err)
	}
	session.IssuedAt = time.Now().Add(-50 * time.Minute).Unix()
	session.ExpiresAt = session.IssuedAt + 3600
	cookie.Value, _ = p.sessionCodec().Encode(tunnelSessionCookie, session)
	w = httptest.NewRecorder()
	if err := p.authorizeTunnel(w, request(), grant.BoxID, grant.Port); err != nil {
		t.Fatal(err)
	}
	if len(w.Result().Cookies()) != 1 {
		t.Fatal("near-expiry session was not renewed")
	}
	for _, mutate := range []func(){
		func() { grant.ID = "another-tunnel" },
		func() { grant.ID = session.Grant.ID; grant.Generation++ },
	} {
		mutate()
		if err := p.authorizeTunnel(httptest.NewRecorder(), request(), grant.BoxID, grant.Port); err == nil || err.status != 401 {
			t.Fatalf("old session accepted: %v", err)
		}
	}
	grant.Generation = 0
	if err := p.authorizeTunnel(httptest.NewRecorder(), request(), grant.BoxID, grant.Port); err == nil || err.status != 404 {
		t.Fatalf("revoked tunnel accepted: %v", err)
	}
}

func TestPrivateTunnelRejectsInvalidExplicitCredentialsAndForeignOrigins(t *testing.T) {
	p, grant := privateAuthProxy(t)
	cookie := tokenSession(t, p)
	for _, test := range []struct {
		name, header, value string
		status              int
	}{
		{"invalid token", accessTokenHeader, "invalid", 401},
		{"invalid API key", platformAuthorizationHeader, "Bearer invalid", 401},
		{"foreign origin", "Origin", "https://4000-other.proxy.test", 403},
		{"same-site sibling", "Sec-Fetch-Site", "same-site", 403},
		// Only a request with no Fetch Metadata at all may lack Sec-Fetch-Site.
		{"partial fetch metadata: mode", "Sec-Fetch-Mode", "cors", 403},
		{"partial fetch metadata: dest", "Sec-Fetch-Dest", "empty", 403},
		{"partial fetch metadata: user", "Sec-Fetch-User", "?1", 403},
	} {
		t.Run(test.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, privateTestURL, nil)
			r.AddCookie(cookie)
			r.Header.Set(test.header, test.value)
			if err := p.authorizeTunnel(httptest.NewRecorder(), r, grant.BoxID, grant.Port); err == nil || err.status != test.status {
				t.Fatalf("expected %d, got %v", test.status, err)
			}
		})
	}
	// The MAC remains valid, but the actual target differs from the signed box.
	grant.BoxID = "OtherBox1234"
	r := httptest.NewRequest(http.MethodGet, "https://3000-OtherBox1234.proxy.test/", nil)
	r.AddCookie(cookie)
	if err := p.authorizeTunnel(httptest.NewRecorder(), r, grant.BoxID, grant.Port); err == nil || err.status != 401 {
		t.Fatalf("cross-box session accepted: %v", err)
	}
}

func TestPrivateTunnelConnectUsesAPIKeyWithoutSettingCookie(t *testing.T) {
	p, grant := privateAuthProxy(t)
	r := httptest.NewRequest(http.MethodConnect, privateTestURL, nil)
	r.Header.Set(platformAuthorizationHeader, "Bearer owner-key")
	w := httptest.NewRecorder()
	if err := p.authorizeTunnel(w, r, grant.BoxID, grant.Port); err != nil {
		t.Fatal(err)
	}
	if len(w.Result().Cookies()) != 0 || r.Header.Get(platformAuthorizationHeader) != "" {
		t.Fatal("CONNECT leaked credentials or issued browser state")
	}
}

// A platform key that authorized the request through the Authorization
// fallback is consumed; only an application's own Authorization reaches the guest.
func TestPrivateTunnelConsumesPlatformAuthorizationFallback(t *testing.T) {
	p, grant := privateAuthProxy(t)
	r := httptest.NewRequest(http.MethodGet, privateTestURL, nil)
	r.Header.Set("Authorization", "Bearer owner-key")
	if err := p.authorizeTunnel(httptest.NewRecorder(), r, grant.BoxID, grant.Port); err != nil {
		t.Fatal(err)
	}
	if r.Header.Get("Authorization") != "" {
		t.Fatal("platform credential reached guest")
	}
}

func TestPrivateTunnelExpiredCookieCanRecoverFromRetainedURL(t *testing.T) {
	p, grant := privateAuthProxy(t)
	cookie := tokenSession(t, p)
	var session tunnelSession
	_ = p.sessionCodec().Decode(tunnelSessionCookie, cookie.Value, &session)
	session.IssuedAt = time.Now().Add(-2 * time.Hour).Unix()
	session.ExpiresAt = session.IssuedAt + 3600
	cookie.Value, _ = p.sessionCodec().Encode(tunnelSessionCookie, session)
	for _, withToken := range []bool{false, true} {
		address := privateTestURL
		if withToken {
			address += "?" + accessTokenQuery + "=" + privateTestToken
		}
		r := httptest.NewRequest(http.MethodGet, address, nil)
		r.AddCookie(cookie)
		err := p.authorizeTunnel(httptest.NewRecorder(), r, grant.BoxID, grant.Port)
		if (err == nil) != withToken {
			t.Fatalf("retained token recovery = %t: %v", withToken, err)
		}
	}
}

func TestPrivateTunnelCookieAllowsSafeLoginReturnButNotSiblingFetch(t *testing.T) {
	p, grant := privateAuthProxy(t)
	cookie := tokenSession(t, p)
	for _, mode := range []string{"navigate", "cors", "websocket"} {
		r := httptest.NewRequest(http.MethodGet, privateTestURL, nil)
		r.AddCookie(cookie)
		r.Header.Set("Sec-Fetch-Site", "cross-site")
		r.Header.Set("Sec-Fetch-Mode", mode)
		r.Header.Set("Sec-Fetch-Dest", "document")
		err := p.authorizeTunnel(httptest.NewRecorder(), r, grant.BoxID, grant.Port)
		if (err == nil) != (mode == "navigate") {
			t.Fatalf("cross-site %s: %v", mode, err)
		}
	}
}

func TestPrivateTunnelUserSessionRechecksMembershipOnEveryRequest(t *testing.T) {
	members := map[string]bool{"member-user": true}
	p, grant := privateAuthProxyWithMembers(t, members)
	login := httptest.NewRecorder()
	if err := p.issueTunnelSession(login, grant, time.Now(), "member-user"); err != nil {
		t.Fatal(err)
	}
	cookie := login.Result().Cookies()[0]
	request := func() *http.Request {
		r := httptest.NewRequest(http.MethodGet, privateTestURL, nil)
		r.AddCookie(cookie)
		return r
	}
	if err := p.authorizeTunnel(httptest.NewRecorder(), request(), grant.BoxID, grant.Port); err != nil {
		t.Fatalf("member session rejected: %v", err)
	}
	delete(members, "member-user")
	if err := p.authorizeTunnel(httptest.NewRecorder(), request(), grant.BoxID, grant.Port); err == nil || err.status != 401 {
		t.Fatalf("removed member kept access: %v", err)
	}
}

func TestPrivateTunnelTokenReplacesUserSession(t *testing.T) {
	p, grant := privateAuthProxy(t)
	login := httptest.NewRecorder()
	if err := p.issueTunnelSession(login, grant, time.Now(), "former-member"); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodGet, privateTestURL+"?"+accessTokenQuery+"="+privateTestToken, nil)
	r.AddCookie(login.Result().Cookies()[0])
	w := httptest.NewRecorder()
	if err := p.authorizeTunnel(w, r, grant.BoxID, grant.Port); err != nil {
		t.Fatal(err)
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatal("explicit token did not replace the organization session")
	}
	var session tunnelSession
	if err := p.sessionCodec().Decode(tunnelSessionCookie, cookies[0].Value, &session); err != nil || session.AuthKind != "token" || session.UserID != "" {
		t.Fatalf("external visitor still depends on organization membership: %v", err)
	}
}

func TestPublicTunnelIgnoresAccessTokensAndPlatformCredentials(t *testing.T) {
	p, grant := privateAuthProxy(t)
	repeated := "?" + accessTokenQuery + "=a&" + accessTokenQuery + "=b"
	for _, test := range []struct {
		name, query, header, value string
	}{
		{"invalid token", "?" + accessTokenQuery + "=invalid", "", ""},
		{"repeated token", repeated, "", ""},
		{"invalid platform credential", "", platformAuthorizationHeader, "Bearer invalid"},
		{"token with platform credential", "?" + accessTokenQuery + "=" + privateTestToken, platformAuthorizationHeader, "Bearer owner-key"},
	} {
		t.Run(test.name, func(t *testing.T) {
			grant.IsPublic = true
			r := httptest.NewRequest(http.MethodGet, privateTestURL+test.query, nil)
			if test.header != "" {
				r.Header.Set(test.header, test.value)
			}
			w := httptest.NewRecorder()
			if err := p.authorizeTunnel(w, r, grant.BoxID, grant.Port); err != nil {
				t.Fatalf("public tunnel refused: %v", err)
			}
			if r.URL.RawQuery != "" || r.Header.Get(platformAuthorizationHeader) != "" {
				t.Fatal("platform credential reached guest")
			}
			if len(w.Result().Cookies()) != 0 {
				t.Fatal("public tunnel issued a session")
			}
		})
	}
	grant.IsPublic = false
	r := httptest.NewRequest(http.MethodGet, privateTestURL+repeated, nil)
	if err := p.authorizeTunnel(httptest.NewRecorder(), r, grant.BoxID, grant.Port); err == nil || err.status != 400 {
		t.Fatalf("private tunnel accepted a repeated token: %v", err)
	}
}

func TestRepeatedAccessTokenIsLeftToTunnelPolicy(t *testing.T) {
	reached := false
	handler := sanitizeTunnelRequests(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		reached = r.URL.RawQuery == "app=1"
	}))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, privateTestURL+"?"+accessTokenQuery+"=a&"+accessTokenQuery+"=b&app=1", nil))
	if !reached {
		t.Fatalf("request stopped before tunnel policy: %d", w.Code)
	}
}
