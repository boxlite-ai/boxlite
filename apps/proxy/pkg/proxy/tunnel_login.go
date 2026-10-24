// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gin-gonic/gin"
	"golang.org/x/oauth2"
)

const loginCookie = "__Host-boxlite-login"
const oidcCookie = "__Host-boxlite-oidc"
const loginCallbackPath = "/__boxlite/auth/callback"
const loginTicketQuery = "boxlite-login-ticket"

type loginState struct {
	Grant     tunnelGrant `json:"grant"`
	ReturnTo  string      `json:"returnTo"`
	NonceHash string      `json:"nonceHash"`
	IssuedAt  int64       `json:"iat"`
}
type oidcBrowserState struct {
	StateHash string
	Verifier  string
	IssuedAt  int64
}
type loginHandoff struct {
	State  loginState
	UserID string
}

func loginDigest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func setLoginCookie(writer http.ResponseWriter, name, value string, maxAge int) {
	http.SetCookie(writer, &http.Cookie{Name: name, Value: value, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: maxAge})
}

func (p *Proxy) getAuthUrl(ctx *gin.Context, boxID string) (string, error) {
	port, _, baseHost, err := p.parseHost(ctx.Request.Host)
	if err != nil {
		return "", err
	}
	grant, accessErr := p.tunnelAccess(ctx.Request.Context(), boxID, port, nil)
	if accessErr != nil {
		return "", accessErr
	}
	nonce, err := GenerateRandomState()
	if err != nil {
		return "", err
	}
	state := loginState{Grant: *grant, ReturnTo: p.config.ProxyProtocol + "://" + ctx.Request.Host + ctx.Request.URL.RequestURI(), NonceHash: loginDigest(nonce), IssuedAt: time.Now().Unix()}
	value, err := p.sessionCodec().Encode("boxlite-login-state", state)
	if err != nil {
		return "", err
	}
	setLoginCookie(ctx.Writer, loginCookie, nonce, 300)
	return p.config.ProxyProtocol + "://" + baseHost + "/login?state=" + url.QueryEscape(value), nil
}

func (p *Proxy) readLoginState(value, callbackHost string) (*loginState, error) {
	var state loginState
	if p.sessionCodec().Decode("boxlite-login-state", value, &state) != nil || time.Now().Unix()-state.IssuedAt > 300 || state.IssuedAt > time.Now().Unix() {
		return nil, fmt.Errorf("invalid login state")
	}
	target, err := url.Parse(state.ReturnTo)
	if err != nil || target.Scheme != p.config.ProxyProtocol || target.User != nil {
		return nil, fmt.Errorf("invalid login destination")
	}
	port, boxID, baseHost, err := p.parseHost(target.Host)
	if decoded, ok, decodeErr := decodeDirectPreviewBoxID(boxID); decodeErr == nil && ok {
		boxID = decoded
	}
	if err != nil || baseHost != callbackHost || boxID != state.Grant.BoxID || port != state.Grant.Port {
		return nil, fmt.Errorf("login target mismatch")
	}
	return &state, nil
}

func (p *Proxy) StartTunnelLogin(ctx *gin.Context) {
	stateValue := ctx.Query("state")
	if _, err := p.readLoginState(stateValue, ctx.Request.Host); err != nil {
		ctx.String(400, "invalid login state")
		return
	}
	_, endpoint, err := p.getOidcEndpoint(ctx.Request.Context())
	if err != nil {
		ctx.String(502, "login provider unavailable")
		return
	}
	verifier := oauth2.GenerateVerifier()
	value, err := p.sessionCodec().Encode(oidcCookie, oidcBrowserState{StateHash: loginDigest(stateValue), Verifier: verifier, IssuedAt: time.Now().Unix()})
	if err != nil {
		ctx.String(500, "cannot start login")
		return
	}
	setLoginCookie(ctx.Writer, oidcCookie, value, 300)
	config := p.loginOAuthConfig(ctx.Request.Host, endpoint)
	ctx.Header("Cache-Control", "no-store")
	ctx.Header("Referrer-Policy", "no-referrer")
	ctx.Redirect(http.StatusFound, config.AuthCodeURL(stateValue, oauth2.SetAuthURLParam("audience", p.config.Oidc.Audience), oauth2.S256ChallengeOption(verifier)))
}

func (p *Proxy) loginOAuthConfig(host string, endpoint *oauth2.Endpoint) oauth2.Config {
	return oauth2.Config{ClientID: p.config.Oidc.ClientId, ClientSecret: p.config.Oidc.ClientSecret,
		RedirectURL: p.config.ProxyProtocol + "://" + host + "/callback", Endpoint: *endpoint, Scopes: []string{oidc.ScopeOpenID, "profile"}}
}

func (p *Proxy) AuthCallback(ctx *gin.Context) {
	ctx.Header("Cache-Control", "no-store")
	ctx.Header("Referrer-Policy", "no-referrer")
	stateValue := ctx.Query("state")
	state, err := p.readLoginState(stateValue, ctx.Request.Host)
	if err != nil || ctx.Query("code") == "" || ctx.Query("error") != "" {
		ctx.String(400, "invalid login callback")
		return
	}
	cookie, err := ctx.Cookie(oidcCookie)
	var browser oidcBrowserState
	if err != nil || p.sessionCodec().Decode(oidcCookie, cookie, &browser) != nil || browser.StateHash != loginDigest(stateValue) || time.Now().Unix()-browser.IssuedAt > 300 {
		ctx.String(401, "login browser state mismatch")
		return
	}
	setLoginCookie(ctx.Writer, oidcCookie, "", -1)
	authCtx, endpoint, err := p.getOidcEndpoint(ctx.Request.Context())
	if err != nil {
		ctx.String(502, "login provider unavailable")
		return
	}
	config := p.loginOAuthConfig(ctx.Request.Host, endpoint)
	token, err := config.Exchange(authCtx, ctx.Query("code"), oauth2.VerifierOption(browser.Verifier))
	if err != nil {
		ctx.String(401, "login code rejected")
		return
	}
	var identity struct {
		Grant  tunnelGrant `json:"grant"`
		UserID string      `json:"userId"`
	}
	path := "preview/" + url.PathEscape(state.Grant.BoxID) + "/tunnels/" + strconv.Itoa(int(state.Grant.Port)) + "/session"
	if p.loginAPI(ctx.Request.Context(), http.MethodGet, path, nil, token.AccessToken, &identity) != nil || identity.Grant != state.Grant || identity.UserID == "" {
		ctx.String(403, "tunnel access denied")
		return
	}
	encoded, err := p.sessionCodec().Encode("boxlite-login-handoff", loginHandoff{State: *state, UserID: identity.UserID})
	if err != nil {
		ctx.String(500, "cannot finish login")
		return
	}
	var result struct {
		Ticket string `json:"ticket"`
	}
	if p.loginAPI(ctx.Request.Context(), http.MethodPost, "preview/tunnel-handoff", map[string]string{"grant": encoded}, "", &result) != nil || result.Ticket == "" {
		ctx.String(502, "login handoff unavailable")
		return
	}
	target, _ := url.Parse(state.ReturnTo)
	target.Path = loginCallbackPath
	target.RawPath = ""
	target.RawQuery = loginTicketQuery + "=" + url.QueryEscape(result.Ticket)
	ctx.Redirect(http.StatusFound, target.String())
}

func (p *Proxy) FinishTunnelLogin(ctx *gin.Context) {
	ctx.Header("Cache-Control", "no-store")
	ctx.Header("Referrer-Policy", "no-referrer")
	ticket, _ := ctx.Request.Context().Value(loginHandoffKey{}).(string)
	if ticket == "" {
		ticket = ctx.Query(loginTicketQuery)
	}
	var result struct {
		Grant string `json:"grant"`
	}
	if ticket == "" || p.loginAPI(ctx.Request.Context(), http.MethodPost, "preview/tunnel-handoff", map[string]string{"ticket": ticket}, "", &result) != nil {
		ctx.String(401, "invalid or expired login handoff")
		return
	}
	var handoff loginHandoff
	if p.sessionCodec().Decode("boxlite-login-handoff", result.Grant, &handoff) != nil {
		ctx.String(401, "invalid login handoff")
		return
	}
	nonce, err := ctx.Cookie(loginCookie)
	target, parseErr := url.Parse(handoff.State.ReturnTo)
	if err != nil || parseErr != nil || target.Host != ctx.Request.Host || target.Scheme != p.config.ProxyProtocol || loginDigest(nonce) != handoff.State.NonceHash {
		ctx.String(401, "login destination mismatch")
		return
	}
	grant, accessErr := p.tunnelAccess(ctx.Request.Context(), handoff.State.Grant.BoxID, handoff.State.Grant.Port, nil, handoff.UserID)
	if accessErr != nil || *grant != handoff.State.Grant {
		ctx.String(403, "tunnel access changed")
		return
	}
	if p.issueTunnelSession(ctx.Writer, grant, time.Now(), handoff.UserID) != nil {
		ctx.String(500, "cannot create tunnel session")
		return
	}
	setLoginCookie(ctx.Writer, loginCookie, "", -1)
	ctx.Redirect(http.StatusSeeOther, target.String())
}

func (p *Proxy) loginAPI(ctx context.Context, method, path string, body any, bearer string, result any) error {
	cfg := p.apiclient.GetConfig()
	endpoint, err := url.JoinPath(cfg.Servers[0].URL, path)
	if err != nil {
		return err
	}
	// A nil body is sent as no body: the API's strict JSON parser rejects `null`.
	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		payload = bytes.NewReader(encoded)
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	r, err := http.NewRequestWithContext(ctx, method, endpoint, payload)
	if err != nil {
		return err
	}
	authorization := cfg.DefaultHeader["Authorization"]
	if bearer != "" {
		authorization = "Bearer " + bearer
	}
	r.Header.Set("Authorization", authorization)
	if payload != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	client := cfg.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(r)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("login API returned %d", response.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(response.Body, 16384)).Decode(result)
}

type loginHandoffKey struct{}
