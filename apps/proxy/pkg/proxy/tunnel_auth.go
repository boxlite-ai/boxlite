// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/securecookie"
)

const accessTokenQuery = "boxlite-access-token"
const accessTokenHeader = "X-BoxLite-Access-Token"
const platformAuthorizationHeader = "X-BoxLite-Authorization"
const sessionLifetime = time.Hour
const sessionRenewalWindow = 15 * time.Minute

type tunnelGrant struct {
	ID         string `json:"id"`
	BoxID      string `json:"boxId"`
	Port       uint16 `json:"port"`
	IsPublic   bool   `json:"isPublic"`
	Generation int    `json:"authGeneration"`
}

type tunnelSession struct {
	Grant     tunnelGrant `json:"grant"`
	AuthKind  string      `json:"authKind"`
	UserID    string      `json:"userId,omitempty"`
	IssuedAt  int64       `json:"iat"`
	ExpiresAt int64       `json:"exp"`
}

type tunnelAuthError struct {
	status  int
	message string
}

func (err *tunnelAuthError) Error() string { return err.message }

func (p *Proxy) tunnelAccess(ctx context.Context, boxID string, port uint16, token *string, identity ...string) (*tunnelGrant, *tunnelAuthError) {
	configuration := p.apiclient.GetConfig()
	endpoint, err := url.JoinPath(configuration.Servers[0].URL, "preview", boxID, "tunnels", strconv.Itoa(int(port)), "access")
	if err != nil {
		return nil, &tunnelAuthError{502, "tunnel access unavailable"}
	}
	userID := ""
	if len(identity) != 0 {
		userID = identity[0]
	}
	body, _ := json.Marshal(struct {
		Token  *string `json:"token,omitempty"`
		UserID string  `json:"userId,omitempty"`
	}{token, userID})
	checkCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(checkCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, &tunnelAuthError{502, "tunnel access unavailable"}
	}
	request.Header.Set("Authorization", configuration.DefaultHeader["Authorization"])
	request.Header.Set("Content-Type", "application/json")
	client := configuration.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, &tunnelAuthError{502, "tunnel access unavailable"}
	}
	defer response.Body.Close()
	if response.StatusCode == 404 {
		return nil, &tunnelAuthError{404, "tunnel not found"}
	}
	if response.StatusCode == 403 {
		return nil, &tunnelAuthError{401, "invalid tunnel token"}
	}
	if response.StatusCode != 200 {
		return nil, &tunnelAuthError{502, "tunnel access unavailable"}
	}
	var grant tunnelGrant
	if json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&grant) != nil || grant.ID == "" || grant.BoxID != boxID || grant.Port != port || grant.Generation < 1 {
		return nil, &tunnelAuthError{502, "invalid tunnel access response"}
	}
	return &grant, nil
}

func (p *Proxy) sessionCodec() *securecookie.SecureCookie {
	key := p.config.TunnelCookieKey
	if key == "" {
		key = p.config.ProxyApiKey
	}
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte("boxlite:tunnel-session:v1"))
	return securecookie.New(mac.Sum(nil), nil).SetSerializer(securecookie.JSONEncoder{}).MaxAge(int(sessionLifetime.Seconds()))
}

func (p *Proxy) readTunnelSession(request *http.Request, grant *tunnelGrant, now time.Time) *tunnelSession {
	cookie, err := request.Cookie(tunnelSessionCookie)
	if err != nil {
		return nil
	}
	var session tunnelSession
	if p.sessionCodec().Decode(tunnelSessionCookie, cookie.Value, &session) != nil ||
		session.Grant != *grant || (session.AuthKind != "token" && (session.AuthKind != "user" || session.UserID == "")) ||
		session.ExpiresAt <= now.Unix() || session.IssuedAt > now.Unix() ||
		session.ExpiresAt-session.IssuedAt != int64(sessionLifetime.Seconds()) {
		return nil
	}
	return &session
}

func (p *Proxy) issueTunnelSession(writer http.ResponseWriter, grant *tunnelGrant, now time.Time, identity ...string) error {
	session := tunnelSession{Grant: *grant, AuthKind: "token", IssuedAt: now.Unix(), ExpiresAt: now.Add(sessionLifetime).Unix()}
	if len(identity) > 0 && identity[0] != "" {
		session.AuthKind = "user"
		session.UserID = identity[0]
	}
	value, err := p.sessionCodec().Encode(tunnelSessionCookie, session)
	if err != nil {
		return err
	}
	http.SetCookie(writer, &http.Cookie{Name: tunnelSessionCookie, Value: value, Path: "/", Secure: true, HttpOnly: true,
		SameSite: http.SameSiteLaxMode, MaxAge: int(sessionLifetime.Seconds()), Expires: now.Add(sessionLifetime)})
	return nil
}

func (p *Proxy) authorizeTunnel(writer http.ResponseWriter, request *http.Request, boxID string, port uint16) *tunnelAuthError {
	token, extractionErr := tunnelToken(request)
	proof := token
	if extractionErr != nil {
		proof = nil
	}
	grant, err := p.tunnelAccess(request.Context(), boxID, port, proof)
	if err != nil {
		return err
	}
	defer request.Header.Del(platformAuthorizationHeader)
	defer request.Header.Del(accessTokenHeader)
	defer stripPlatformCookies(request)
	// A public tunnel admits every visitor: tokens and platform credentials are
	// stripped without being checked.
	if grant.IsPublic {
		return nil
	}
	if extractionErr != nil {
		return extractionErr
	}
	platformHeader, explicitPlatform := request.Header[http.CanonicalHeaderKey(platformAuthorizationHeader)]
	if explicitPlatform && (len(platformHeader) != 1 || token != nil) {
		return &tunnelAuthError{400, "ambiguous tunnel credentials"}
	}
	*request = *request.WithContext(context.WithValue(request.Context(), privateTunnelKey{}, true))
	writer.Header().Set("Cache-Control", "private, no-store")
	writer.Header().Set("Referrer-Policy", "no-referrer")
	now := time.Now()
	session := p.readTunnelSession(request, grant, now)
	if explicitPlatform {
		return p.authorizeTunnelBearer(request, boxID, platformHeader[0])
	}
	if token != nil {
		if request.Method != http.MethodConnect && (session == nil || session.AuthKind != "token" || session.ExpiresAt-now.Unix() <= int64(sessionRenewalWindow.Seconds())) {
			if p.issueTunnelSession(writer, grant, now) != nil {
				return &tunnelAuthError{500, "cannot create tunnel session"}
			}
		}
		return nil
	}
	if session != nil {
		if !p.sameTunnelOrigin(request) {
			return &tunnelAuthError{403, "cross-origin tunnel session denied"}
		}
		if session.AuthKind == "user" {
			current, err := p.tunnelAccess(request.Context(), boxID, port, nil, session.UserID)
			if err != nil {
				return err
			}
			if *current != *grant {
				return &tunnelAuthError{401, "tunnel session changed"}
			}
		}
		if request.Method != http.MethodConnect && session.ExpiresAt-now.Unix() <= int64(sessionRenewalWindow.Seconds()) {
			if p.issueTunnelSession(writer, grant, now, session.UserID) != nil {
				return &tunnelAuthError{500, "cannot renew tunnel session"}
			}
		}
		return nil
	}
	if authorization := request.Header.Get("Authorization"); strings.HasPrefix(authorization, "Bearer ") {
		if err := p.authorizeTunnelBearer(request, boxID, authorization); err != nil {
			return err
		}
		request.Header.Del("Authorization")
		return nil
	}
	return &tunnelAuthError{401, "private tunnel requires an API key, JWT, or access token"}
}

func (p *Proxy) authorizeTunnelBearer(request *http.Request, boxID, header string) *tunnelAuthError {
	token, ok := strings.CutPrefix(header, "Bearer ")
	if !ok || strings.TrimSpace(token) == "" {
		return &tunnelAuthError{401, "invalid platform credential"}
	}
	ctx := request.Context()
	if ctx.Value(clientIPContextKey{}) == nil {
		if ip, _, err := net.SplitHostPort(request.RemoteAddr); err == nil {
			ctx = context.WithValue(ctx, clientIPContextKey{}, ip)
		}
	}
	valid, err := p.getBoxBearerTokenValid(ctx, boxID, strings.TrimSpace(token))
	if err != nil {
		return &tunnelAuthError{502, "platform authorization unavailable"}
	}
	if valid == nil || !*valid {
		return &tunnelAuthError{401, "invalid platform credential"}
	}
	return nil
}

func (p *Proxy) sameTunnelOrigin(request *http.Request) bool {
	origin := request.Header.Get("Origin")
	if origin != "" {
		return origin == fmt.Sprintf("%s://%s", p.config.ProxyProtocol, request.Host)
	}
	// Top-level safe navigation (including the OIDC return) cannot expose the
	// response to a sibling site's script. Fetches and upgrades still require
	// the exact origin; redirects retain the initiating site's Fetch Metadata.
	if (request.Method == http.MethodGet || request.Method == http.MethodHead) &&
		request.Header.Get("Sec-Fetch-Mode") == "navigate" && request.Header.Get("Sec-Fetch-Dest") == "document" {
		return true
	}
	site := request.Header.Get("Sec-Fetch-Site")
	if site == "" {
		// Only a client that sends no Fetch Metadata at all (non-browser or
		// legacy) may omit the site.
		for _, header := range []string{"Sec-Fetch-Mode", "Sec-Fetch-Dest", "Sec-Fetch-User"} {
			if request.Header.Get(header) != "" {
				return false
			}
		}
		return true
	}
	return site == "none" || site == "same-origin"
}

type tunnelTokenKey struct{}
type privateTunnelKey struct{}
type capturedTunnelToken struct {
	token *string
	err   *tunnelAuthError
}

// Run before tracing: the browser retains its URL, while logs and the guest see
// only application query parameters. Keep their original escaping and order.
func tunnelToken(request *http.Request) (*string, *tunnelAuthError) {
	if captured, ok := request.Context().Value(tunnelTokenKey{}).(capturedTunnelToken); ok {
		return captured.token, captured.err
	}
	var captured capturedTunnelToken
	kept := []string{}
	for _, part := range strings.Split(request.URL.RawQuery, "&") {
		key, value, _ := strings.Cut(part, "=")
		decodedKey, _ := url.QueryUnescape(key)
		if decodedKey != accessTokenQuery {
			kept = append(kept, part)
			continue
		}
		decoded, err := url.QueryUnescape(value)
		if captured.token != nil || err != nil {
			captured.err = &tunnelAuthError{400, "invalid tunnel token parameter"}
		}
		captured.token = &decoded
	}
	request.URL.RawQuery = strings.Join(kept, "&")
	request.RequestURI = request.URL.RequestURI()
	if headers, present := request.Header[http.CanonicalHeaderKey(accessTokenHeader)]; present {
		if len(headers) != 1 || captured.token != nil {
			captured.err = &tunnelAuthError{400, "ambiguous tunnel credentials"}
		} else {
			captured.token = &headers[0]
		}
	}
	if captured.token != nil && len(*captured.token) > 256 {
		captured.err = &tunnelAuthError{400, "invalid tunnel token"}
	}
	if referer, err := url.Parse(request.Header.Get("Referer")); err == nil && referer.Query().Has(accessTokenQuery) {
		request.Header.Del("Referer")
	}
	*request = *request.WithContext(context.WithValue(request.Context(), tunnelTokenKey{}, captured))
	return captured.token, captured.err
}

func sanitizeTunnelRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == loginCallbackPath {
			query := request.URL.Query()
			ticket := query.Get(loginTicketQuery)
			query.Del(loginTicketQuery)
			request.URL.RawQuery = query.Encode()
			request = request.WithContext(context.WithValue(request.Context(), loginHandoffKey{}, ticket))
		}
		// A malformed token is refused only by a private tunnel's policy.
		if token, _ := tunnelToken(request); token != nil {
			writer.Header().Set("Referrer-Policy", "no-referrer")
			writer.Header().Set("Cache-Control", "private, no-store")
			request.Header.Del(accessTokenHeader)
		}
		next.ServeHTTP(writer, request)
	})
}
