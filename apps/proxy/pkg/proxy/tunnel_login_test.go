// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func loginContext(address string, cookies ...*http.Cookie) (*gin.Context, *httptest.ResponseRecorder) {
	w := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(w)
	ctx.Request = httptest.NewRequest(http.MethodGet, address, nil)
	for _, cookie := range cookies {
		ctx.Request.AddCookie(cookie)
	}
	return ctx, w
}

func TestPrivateTunnelOIDCUsesHostOnlySingleUseBrowserBoundHandoff(t *testing.T) {
	for _, wrongBrowser := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "wrong browser"}[wrongBrowser], func(t *testing.T) {
			p, grant := privateAuthProxy(t)
			var savedGrant, challenge string
			usedCode := false
			var identity *httptest.Server
			identity = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/.well-known/openid-configuration":
					_ = json.NewEncoder(w).Encode(map[string]any{"issuer": identity.URL, "authorization_endpoint": identity.URL + "/authorize", "token_endpoint": identity.URL + "/token", "jwks_uri": identity.URL + "/keys"})
				case "/token":
					_ = r.ParseForm()
					sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
					if usedCode || r.Form.Get("code") != "login-code" || base64.RawURLEncoding.EncodeToString(sum[:]) != challenge {
						w.WriteHeader(401)
						return
					}
					usedCode = true
					_, _ = w.Write([]byte(`{"access_token":"owner-key","token_type":"Bearer","expires_in":3600}`))
				default:
					w.WriteHeader(404)
				}
			}))
			defer identity.Close()
			p.config.Oidc.Domain = identity.URL
			p.config.Oidc.ClientId = "proxy-client"
			previousAPI := p.apiclient.GetConfig().Servers[0].URL
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case strings.HasSuffix(r.URL.Path, "/session"):
					// Like the API's strict JSON parser: a body that is not an
					// object or array (such as `null`) is rejected before the handler.
					if body, _ := io.ReadAll(r.Body); len(bytes.TrimSpace(body)) > 0 &&
						!bytes.HasPrefix(bytes.TrimSpace(body), []byte("{")) && !bytes.HasPrefix(bytes.TrimSpace(body), []byte("[")) {
						w.WriteHeader(400)
						return
					}
					if r.Header.Get("Authorization") != "Bearer owner-key" {
						w.WriteHeader(401)
						return
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"grant": grant, "userId": "member"})
				case r.URL.Path == "/preview/tunnel-handoff":
					var body map[string]string
					_ = json.NewDecoder(r.Body).Decode(&body)
					if body["grant"] != "" {
						savedGrant = body["grant"]
						_ = json.NewEncoder(w).Encode(map[string]string{"ticket": "one-time-ticket"})
						return
					}
					if body["ticket"] != "one-time-ticket" || savedGrant == "" {
						w.WriteHeader(401)
						return
					}
					value := savedGrant
					savedGrant = ""
					_ = json.NewEncoder(w).Encode(map[string]string{"grant": value})
				default:
					upstream, _ := http.NewRequest(r.Method, previousAPI+r.URL.Path, r.Body)
					response, err := http.DefaultClient.Do(upstream)
					if err != nil {
						w.WriteHeader(502)
						return
					}
					defer response.Body.Close()
					w.WriteHeader(response.StatusCode)
					var body any
					_ = json.NewDecoder(response.Body).Decode(&body)
					_ = json.NewEncoder(w).Encode(body)
				}
			}))
			defer api.Close()
			p.apiclient.GetConfig().Servers[0].URL = api.URL
			ctx, initial := loginContext(privateTestURL + "app?view=1")
			location, err := p.getAuthUrl(ctx, grant.BoxID)
			if err != nil {
				t.Fatal(err)
			}
			nonce := initial.Result().Cookies()[0]
			if nonce.Domain != "" || !nonce.Secure || !nonce.HttpOnly {
				t.Fatal("unsafe target nonce cookie")
			}
			ctx, start := loginContext(location)
			p.StartTunnelLogin(ctx)
			if start.Code != 302 {
				t.Fatalf("login start: %d %s", start.Code, start.Body.String())
			}
			authURL, _ := url.Parse(start.Header().Get("Location"))
			challenge = authURL.Query().Get("code_challenge")
			callback := "https://proxy.test/callback?code=login-code&state=" + url.QueryEscape(authURL.Query().Get("state"))
			pkce := start.Result().Cookies()[0]
			if pkce.Domain != "" || !pkce.Secure || !pkce.HttpOnly {
				t.Fatal("unsafe central PKCE cookie")
			}
			ctx, rejected := loginContext(callback)
			p.AuthCallback(ctx)
			if rejected.Code != 401 || usedCode {
				t.Fatal("callback accepted a browser without PKCE state")
			}
			ctx, exchanged := loginContext(callback, pkce)
			p.AuthCallback(ctx)
			if exchanged.Code != 302 {
				t.Fatalf("callback: %d %s", exchanged.Code, exchanged.Body.String())
			}
			for _, cookie := range exchanged.Result().Cookies() {
				if cookie.Name == tunnelSessionCookie {
					t.Fatal("central callback issued target cookie")
				}
			}
			targetURL := exchanged.Header().Get("Location")
			if wrongBrowser {
				nonce.Value = "another-browser"
			}
			ctx, finished := loginContext(targetURL, nonce)
			p.FinishTunnelLogin(ctx)
			if wrongBrowser {
				if finished.Code != 401 {
					t.Fatalf("wrong browser admitted: %d", finished.Code)
				}
			} else {
				if finished.Code != 303 || finished.Header().Get("Location") != privateTestURL+"app?view=1" {
					t.Fatalf("finish: %d %s", finished.Code, finished.Body.String())
				}
				cookie := finished.Result().Cookies()[0]
				if cookie.Name != tunnelSessionCookie || cookie.Domain != "" {
					t.Fatal("session cookie is not host-only")
				}
				ctx, replay := loginContext(targetURL, nonce)
				p.FinishTunnelLogin(ctx)
				if replay.Code != 401 {
					t.Fatal("handoff ticket replay was accepted")
				}
			}
		})
	}
}
