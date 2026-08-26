// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	clickStackGatewayDefaultPort        = 4000
	clickStackReadinessTimeout          = 3 * time.Second
	clickStackReadinessBodyLimit        = 1 << 20
	clickStackRuntimeEnvBodyLimit       = 64 << 10
	clickStackRuntimeEnvPath            = "/clickstack/__ENV.js"
	clickStackResponseHeaderTimeout     = 30 * time.Second
	clickStackHandoffBodyLimit          = 2 << 10
	clickStackHandoffRateLimit          = 20
	clickStackHandoffMaxInFlight        = 8
	clickStackRedeemBodyLimit           = 1 << 10
	clickStackSessionMaximumTTL         = time.Hour
	clickStackSessionClockSkew          = 30 * time.Second
	clickStackSessionValidationInterval = time.Minute
	clickStackSessionCacheMaxEntries    = 1024
	clickStackSessionCookie             = "__Host-boxlite_clickstack"
)

var clickStackHandoffCodePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

type ClickStackGatewayConfig struct {
	UpstreamURL             string
	Username                string
	Password                string
	Port                    int
	BackofficeRedeemURL     string
	BackofficeIntrospectURL string
	BackofficeEntryURL      string
	RedeemToken             string
	SessionKeys             string
}

type clickStackSessionBinding struct {
	ID        string
	ExpiresAt time.Time
}

type clickStackBackofficeClient interface {
	Redeem(context.Context, string) (clickStackSessionBinding, error)
	Introspect(context.Context, string) (bool, error)
}

type clickStackSessionIntrospector interface {
	Introspect(context.Context, string) (bool, error)
}

type httpClickStackBackofficeClient struct {
	redeemURL     string
	introspectURL string
	token         string
	client        *http.Client
}

type clickStackSessionManager struct {
	current  []byte
	previous []byte
	now      func() time.Time
}

type clickStackSessionCacheEntry struct {
	binding    clickStackSessionBinding
	active     bool
	validUntil time.Time
}

type clickStackSessionValidationFlight struct {
	done   chan struct{}
	active bool
	err    error
}

type clickStackSessionAuthorizer struct {
	mu           sync.Mutex
	introspector clickStackSessionIntrospector
	entries      map[string]clickStackSessionCacheEntry
	flights      map[string]*clickStackSessionValidationFlight
	now          func() time.Time
}

type clickStackHandoffLimiter struct {
	mu            sync.Mutex
	windowStarted time.Time
	requests      int
	inFlight      chan struct{}
	now           func() time.Time
}

type clickStackSessionKeyConfig struct {
	Current  string `json:"current"`
	Previous string `json:"previous,omitempty"`
}

func ClickStackGatewayEnabled() bool {
	return os.Getenv("CLICKSTACK_UPSTREAM_URL") != ""
}

func ClickStackGatewayConfigFromEnv() (ClickStackGatewayConfig, error) {
	port := clickStackGatewayDefaultPort
	if rawPort := os.Getenv("PROXY_PORT"); rawPort != "" {
		parsed, err := strconv.Atoi(rawPort)
		if err != nil {
			return ClickStackGatewayConfig{}, fmt.Errorf("PROXY_PORT must be a number")
		}
		port = parsed
	}
	return ClickStackGatewayConfig{
		UpstreamURL:             os.Getenv("CLICKSTACK_UPSTREAM_URL"),
		Username:                os.Getenv("CLICKSTACK_USERNAME"),
		Password:                os.Getenv("CLICKSTACK_PASSWORD"),
		Port:                    port,
		BackofficeRedeemURL:     os.Getenv("CLICKSTACK_BACKOFFICE_REDEEM_URL"),
		BackofficeIntrospectURL: os.Getenv("CLICKSTACK_BACKOFFICE_INTROSPECT_URL"),
		BackofficeEntryURL:      os.Getenv("CLICKSTACK_BACKOFFICE_ENTRY_URL"),
		RedeemToken:             os.Getenv("CLICKSTACK_REDEEM_TOKEN"),
		SessionKeys:             os.Getenv("CLICKSTACK_SESSION_KEYS"),
	}, nil
}

func validateClickStackGatewayConfig(config ClickStackGatewayConfig) (*url.URL, error) {
	target, err := url.Parse(config.UpstreamURL)
	if err != nil || target.Host == "" || (target.Scheme != "http" && target.Scheme != "https") {
		return nil, fmt.Errorf("CLICKSTACK_UPSTREAM_URL must be an HTTP(S) origin")
	}
	if target.User != nil || (target.Path != "" && target.Path != "/") || target.RawQuery != "" || target.Fragment != "" {
		return nil, fmt.Errorf("CLICKSTACK_UPSTREAM_URL must not contain credentials, a path, query, or fragment")
	}
	if config.Username == "" {
		return nil, fmt.Errorf("CLICKSTACK_USERNAME is required")
	}
	if config.Password == "" {
		return nil, fmt.Errorf("CLICKSTACK_PASSWORD is required")
	}
	redeemURL, err := cleanClickStackPublicURL(config.BackofficeRedeemURL, "CLICKSTACK_BACKOFFICE_REDEEM_URL")
	if err != nil {
		return nil, err
	}
	introspectURL, err := cleanClickStackPublicURL(config.BackofficeIntrospectURL, "CLICKSTACK_BACKOFFICE_INTROSPECT_URL")
	if err != nil {
		return nil, err
	}
	entryURL, err := cleanClickStackPublicURL(config.BackofficeEntryURL, "CLICKSTACK_BACKOFFICE_ENTRY_URL")
	if err != nil {
		return nil, err
	}
	if redeemURL.Scheme+"://"+redeemURL.Host != entryURL.Scheme+"://"+entryURL.Host ||
		introspectURL.Scheme+"://"+introspectURL.Host != entryURL.Scheme+"://"+entryURL.Host {
		return nil, fmt.Errorf("ClickStack Backoffice URLs must share one origin")
	}
	if _, err := currentClickStackRedeemToken(config.RedeemToken); err != nil {
		return nil, err
	}
	if _, err := newClickStackSessionManager(config.SessionKeys, time.Now); err != nil {
		return nil, err
	}
	return target, nil
}

func currentClickStackRedeemToken(encoded string) (string, error) {
	if clickStackHandoffCodePattern.MatchString(encoded) {
		return encoded, nil
	}
	decoder := json.NewDecoder(strings.NewReader(encoded))
	decoder.DisallowUnknownFields()
	var config clickStackSessionKeyConfig
	if err := decoder.Decode(&config); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return "", fmt.Errorf("CLICKSTACK_REDEEM_TOKEN must be a 32-byte token or valid key-set JSON")
	}
	current, err := decodeClickStackSessionKey(config.Current)
	if err != nil {
		return "", fmt.Errorf("CLICKSTACK_REDEEM_TOKEN current key is invalid")
	}
	if config.Previous != "" {
		previous, previousErr := decodeClickStackSessionKey(config.Previous)
		if previousErr != nil || hmac.Equal(current, previous) {
			return "", fmt.Errorf("CLICKSTACK_REDEEM_TOKEN previous key is invalid")
		}
	}
	return config.Current, nil
}

func cleanClickStackPublicURL(value, name string) (*url.URL, error) {
	parsed, err := url.Parse(value)
	localHTTP := err == nil && parsed.Scheme == "http" && (parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1")
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && !localHTTP) || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("%s must be a credential-free HTTPS URL", name)
	}
	return parsed, nil
}

func newClickStackSessionManager(encoded string, now func() time.Time) (*clickStackSessionManager, error) {
	decoder := json.NewDecoder(strings.NewReader(encoded))
	decoder.DisallowUnknownFields()
	var config clickStackSessionKeyConfig
	if err := decoder.Decode(&config); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return nil, fmt.Errorf("CLICKSTACK_SESSION_KEYS must be valid key-set JSON")
	}
	current, err := decodeClickStackSessionKey(config.Current)
	if err != nil {
		return nil, fmt.Errorf("CLICKSTACK_SESSION_KEYS current key is invalid")
	}
	var previous []byte
	if config.Previous != "" {
		previous, err = decodeClickStackSessionKey(config.Previous)
		if err != nil || hmac.Equal(current, previous) {
			return nil, fmt.Errorf("CLICKSTACK_SESSION_KEYS previous key is invalid")
		}
	}
	return &clickStackSessionManager{current: current, previous: previous, now: now}, nil
}

func decodeClickStackSessionKey(value string) ([]byte, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) != 32 {
		return nil, errors.New("session key must contain exactly 32 bytes")
	}
	return decoded, nil
}

func (sessions *clickStackSessionManager) Issue(binding clickStackSessionBinding) (*http.Cookie, error) {
	now := sessions.now()
	if !clickStackHandoffCodePattern.MatchString(binding.ID) {
		return nil, fmt.Errorf("Backoffice session id is invalid")
	}
	remaining := binding.ExpiresAt.Sub(now)
	if remaining < time.Second || remaining > clickStackSessionMaximumTTL+clickStackSessionClockSkew {
		return nil, fmt.Errorf("Backoffice session expiry is invalid")
	}
	payload := fmt.Sprintf("v2.%d.%s", binding.ExpiresAt.Unix(), binding.ID)
	value := payload + "." + signClickStackSession(payload, sessions.current)
	maxAge := int(remaining.Seconds())
	return &http.Cookie{
		Name:     clickStackSessionCookie,
		Value:    value,
		Path:     "/",
		Expires:  binding.ExpiresAt,
		MaxAge:   maxAge,
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	}, nil
}

func (sessions *clickStackSessionManager) Verify(value string) (clickStackSessionBinding, bool) {
	parts := strings.Split(value, ".")
	if len(parts) != 4 || parts[0] != "v2" {
		return clickStackSessionBinding{}, false
	}
	expiresUnix, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return clickStackSessionBinding{}, false
	}
	now := sessions.now()
	expires := time.Unix(expiresUnix, 0).UTC()
	if !expires.After(now) || expires.After(now.Add(clickStackSessionMaximumTTL+clickStackSessionClockSkew)) {
		return clickStackSessionBinding{}, false
	}
	if !clickStackHandoffCodePattern.MatchString(parts[2]) {
		return clickStackSessionBinding{}, false
	}
	payload := strings.Join(parts[:3], ".")
	provided, err := base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil {
		return clickStackSessionBinding{}, false
	}
	for _, key := range [][]byte{sessions.current, sessions.previous} {
		if len(key) == 0 {
			continue
		}
		expected, _ := base64.RawURLEncoding.DecodeString(signClickStackSession(payload, key))
		if hmac.Equal(provided, expected) {
			return clickStackSessionBinding{ID: parts[2], ExpiresAt: expires}, true
		}
	}
	return clickStackSessionBinding{}, false
}

func signClickStackSession(payload string, key []byte) string {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func clearClickStackSessionCookie(writer http.ResponseWriter) {
	http.SetCookie(writer, &http.Cookie{
		Name:     clickStackSessionCookie,
		Path:     "/",
		MaxAge:   -1,
		Expires:  time.Unix(1, 0),
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
}

func newClickStackSessionAuthorizer(
	introspector clickStackSessionIntrospector,
	now func() time.Time,
) *clickStackSessionAuthorizer {
	return &clickStackSessionAuthorizer{
		introspector: introspector,
		entries:      make(map[string]clickStackSessionCacheEntry),
		flights:      make(map[string]*clickStackSessionValidationFlight),
		now:          now,
	}
}

func (authorizer *clickStackSessionAuthorizer) Seed(binding clickStackSessionBinding) {
	authorizer.mu.Lock()
	defer authorizer.mu.Unlock()
	now := authorizer.now()
	if !binding.ExpiresAt.After(now) {
		return
	}
	authorizer.storeLocked(clickStackSessionCacheEntry{
		binding:    binding,
		active:     true,
		validUntil: minClickStackTime(now.Add(clickStackSessionValidationInterval), binding.ExpiresAt),
	}, now)
}

func (authorizer *clickStackSessionAuthorizer) Authorize(
	ctx context.Context,
	binding clickStackSessionBinding,
) (bool, error) {
	authorizer.mu.Lock()
	now := authorizer.now()
	if !binding.ExpiresAt.After(now) {
		authorizer.mu.Unlock()
		return false, nil
	}
	if entry, ok := authorizer.entries[binding.ID]; ok && entry.binding.ExpiresAt.Equal(binding.ExpiresAt) && now.Before(entry.validUntil) {
		authorizer.mu.Unlock()
		return entry.active, nil
	}
	if flight, ok := authorizer.flights[binding.ID]; ok {
		authorizer.mu.Unlock()
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case <-flight.done:
			return flight.active, flight.err
		}
	}
	flight := &clickStackSessionValidationFlight{done: make(chan struct{})}
	authorizer.flights[binding.ID] = flight
	authorizer.mu.Unlock()

	active, err := authorizer.introspector.Introspect(ctx, binding.ID)

	authorizer.mu.Lock()
	validatedAt := authorizer.now()
	if err == nil {
		authorizer.storeLocked(clickStackSessionCacheEntry{
			binding:    binding,
			active:     active,
			validUntil: minClickStackTime(validatedAt.Add(clickStackSessionValidationInterval), binding.ExpiresAt),
		}, validatedAt)
	}
	flight.active = active
	flight.err = err
	delete(authorizer.flights, binding.ID)
	close(flight.done)
	authorizer.mu.Unlock()
	return active, err
}

func (authorizer *clickStackSessionAuthorizer) CacheSize() int {
	authorizer.mu.Lock()
	defer authorizer.mu.Unlock()
	return len(authorizer.entries)
}

func (authorizer *clickStackSessionAuthorizer) storeLocked(entry clickStackSessionCacheEntry, now time.Time) {
	for sessionID, candidate := range authorizer.entries {
		if !candidate.binding.ExpiresAt.After(now) {
			delete(authorizer.entries, sessionID)
		}
	}
	if _, exists := authorizer.entries[entry.binding.ID]; !exists && len(authorizer.entries) >= clickStackSessionCacheMaxEntries {
		var oldestSessionID string
		var oldest time.Time
		for sessionID, candidate := range authorizer.entries {
			if oldestSessionID == "" || candidate.validUntil.Before(oldest) {
				oldestSessionID = sessionID
				oldest = candidate.validUntil
			}
		}
		delete(authorizer.entries, oldestSessionID)
	}
	authorizer.entries[entry.binding.ID] = entry
}

func minClickStackTime(left, right time.Time) time.Time {
	if left.Before(right) {
		return left
	}
	return right
}

func newClickStackHandoffLimiter(now func() time.Time) *clickStackHandoffLimiter {
	return &clickStackHandoffLimiter{inFlight: make(chan struct{}, clickStackHandoffMaxInFlight), now: now}
}

func (limiter *clickStackHandoffLimiter) Acquire() bool {
	select {
	case limiter.inFlight <- struct{}{}:
	default:
		return false
	}

	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	now := limiter.now()
	if limiter.windowStarted.IsZero() || now.Before(limiter.windowStarted) || now.Sub(limiter.windowStarted) >= time.Second {
		limiter.windowStarted = now
		limiter.requests = 0
	}
	if limiter.requests >= clickStackHandoffRateLimit {
		<-limiter.inFlight
		return false
	}
	limiter.requests++
	return true
}

func (limiter *clickStackHandoffLimiter) Release() {
	<-limiter.inFlight
}

func newHTTPClickStackBackofficeClient(
	redeemURL string,
	introspectURL string,
	redeemToken string,
) *httpClickStackBackofficeClient {
	return &httpClickStackBackofficeClient{
		redeemURL:     redeemURL,
		introspectURL: introspectURL,
		token:         redeemToken,
		client: &http.Client{
			Transport: newClickStackTransport(5 * time.Second),
			Timeout:   5 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

func (client *httpClickStackBackofficeClient) Redeem(
	ctx context.Context,
	code string,
) (clickStackSessionBinding, error) {
	var result struct {
		Active    *bool  `json:"active"`
		SessionID string `json:"sessionId"`
		ExpiresAt string `json:"expiresAt"`
	}
	if err := client.post(ctx, client.redeemURL, map[string]string{"code": code}, &result); err != nil {
		return clickStackSessionBinding{}, err
	}
	if result.Active == nil || !*result.Active || !clickStackHandoffCodePattern.MatchString(result.SessionID) {
		return clickStackSessionBinding{}, errors.New("Backoffice handoff was rejected")
	}
	expiresAt, err := time.Parse(time.RFC3339, result.ExpiresAt)
	if err != nil {
		return clickStackSessionBinding{}, errors.New("Backoffice handoff was rejected")
	}
	return clickStackSessionBinding{ID: result.SessionID, ExpiresAt: expiresAt}, nil
}

func (client *httpClickStackBackofficeClient) Introspect(ctx context.Context, sessionID string) (bool, error) {
	var result struct {
		Active *bool `json:"active"`
	}
	if err := client.post(
		ctx,
		client.introspectURL,
		map[string]string{"sessionId": sessionID},
		&result,
	); err != nil {
		return false, err
	}
	if result.Active == nil {
		return false, errors.New("Backoffice session response is invalid")
	}
	return *result.Active, nil
}

func (client *httpClickStackBackofficeClient) post(
	ctx context.Context,
	endpoint string,
	payload map[string]string,
	result any,
) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return errors.New("encode Backoffice session request")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return errors.New("build Backoffice session request")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+client.token)
	response, err := client.client.Do(request)
	if err != nil {
		return errors.New("Backoffice session service is unavailable")
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, clickStackRedeemBodyLimit+1))
	if err != nil || len(responseBody) > clickStackRedeemBodyLimit || response.StatusCode != http.StatusOK {
		return errors.New("Backoffice session request was rejected")
	}
	decoder := json.NewDecoder(bytes.NewReader(responseBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(result); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return errors.New("Backoffice session response is invalid")
	}
	return nil
}

func newClickStackGatewayHandler(
	config ClickStackGatewayConfig,
	transport http.RoundTripper,
	backoffice clickStackBackofficeClient,
) (http.Handler, error) {
	target, err := validateClickStackGatewayConfig(config)
	if err != nil {
		return nil, err
	}
	if backoffice == nil {
		return nil, fmt.Errorf("ClickStack Backoffice client is required")
	}
	sessions, err := newClickStackSessionManager(config.SessionKeys, time.Now)
	if err != nil {
		return nil, err
	}
	if transport == nil {
		transport = newClickStackTransport(clickStackResponseHeaderTimeout)
	}
	backofficeEntry, _ := cleanClickStackPublicURL(config.BackofficeEntryURL, "CLICKSTACK_BACKOFFICE_ENTRY_URL")
	handoffLimiter := newClickStackHandoffLimiter(time.Now)
	authorizer := newClickStackSessionAuthorizer(backoffice, time.Now)

	reverseProxy := newClickStackReverseProxy(target, config, transport)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("GET /ready", func(writer http.ResponseWriter, request *http.Request) {
		ctx, cancel := context.WithTimeout(request.Context(), clickStackReadinessTimeout)
		defer cancel()
		if err := checkClickStackReadiness(ctx, target, config, transport); err != nil {
			slog.Warn("ClickStack readiness check failed", "error", err)
			http.Error(writer, "ClickStack upstream is unavailable", http.StatusServiceUnavailable)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"status":"ready"}`))
	})
	mux.HandleFunc("POST /auth/backoffice", func(writer http.ResponseWriter, request *http.Request) {
		handleClickStackHandoff(
			writer,
			request,
			backofficeEntry.Scheme+"://"+backofficeEntry.Host,
			sessions,
			backoffice,
			authorizer,
			handoffLimiter,
		)
	})
	mux.Handle("/", requireClickStackSession(sessions, authorizer, config.BackofficeEntryURL, reverseProxy))
	return mux, nil
}

func newClickStackReverseProxy(target *url.URL, config ClickStackGatewayConfig, transport http.RoundTripper) *httputil.ReverseProxy {
	return &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(target)
			if request.Out.URL.Path == "/__ENV.js" {
				request.Out.URL.Path = clickStackRuntimeEnvPath
			}
			request.Out.Host = target.Host
			query := request.Out.URL.Query()
			query.Del("user")
			query.Del("password")
			request.Out.URL.RawQuery = query.Encode()
			for _, header := range []string{
				"Authorization", "Cookie", "X-Amzn-Oidc-Accesstoken", "X-Amzn-Oidc-Data",
				"X-Amzn-Oidc-Identity", "X-ClickHouse-User", "X-ClickHouse-Key",
			} {
				request.Out.Header.Del(header)
			}
			request.Out.Header.Set("X-ClickHouse-User", config.Username)
			request.Out.Header.Set("X-ClickHouse-Key", config.Password)
		},
		ErrorHandler: func(writer http.ResponseWriter, _ *http.Request, err error) {
			slog.Error("ClickStack upstream request failed", "error", err)
			http.Error(writer, "ClickStack upstream is unavailable", http.StatusBadGateway)
		},
	}
}

func handleClickStackHandoff(
	writer http.ResponseWriter,
	request *http.Request,
	backofficeOrigin string,
	sessions *clickStackSessionManager,
	backoffice clickStackBackofficeClient,
	authorizer *clickStackSessionAuthorizer,
	limiter *clickStackHandoffLimiter,
) {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/x-www-form-urlencoded" || request.URL.RawQuery != "" || request.Header.Get("Origin") != backofficeOrigin {
		http.Error(writer, "invalid ClickStack handoff", http.StatusBadRequest)
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, clickStackHandoffBodyLimit)
	if err := request.ParseForm(); err != nil || len(request.PostForm) != 1 || len(request.PostForm["code"]) != 1 {
		http.Error(writer, "invalid ClickStack handoff", http.StatusBadRequest)
		return
	}
	code := request.PostForm.Get("code")
	if !clickStackHandoffCodePattern.MatchString(code) {
		http.Error(writer, "invalid ClickStack handoff", http.StatusBadRequest)
		return
	}
	if !limiter.Acquire() {
		writer.Header().Set("Retry-After", "1")
		http.Error(writer, "ClickStack handoff is busy", http.StatusTooManyRequests)
		return
	}
	defer limiter.Release()
	binding, err := backoffice.Redeem(request.Context(), code)
	if err != nil {
		http.Error(writer, "ClickStack handoff was rejected", http.StatusUnauthorized)
		return
	}
	cookie, err := sessions.Issue(binding)
	if err != nil {
		http.Error(writer, "ClickStack handoff was rejected", http.StatusUnauthorized)
		return
	}
	authorizer.Seed(binding)
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Referrer-Policy", "no-referrer")
	http.SetCookie(writer, cookie)
	http.Redirect(writer, request, "/clickstack", http.StatusSeeOther)
}

func requireClickStackSession(
	sessions *clickStackSessionManager,
	authorizer *clickStackSessionAuthorizer,
	backofficeEntryURL string,
	next http.Handler,
) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		cookie, err := request.Cookie(clickStackSessionCookie)
		var binding clickStackSessionBinding
		var verified bool
		if err == nil {
			binding, verified = sessions.Verify(cookie.Value)
		}
		if err != nil || !verified {
			if err == nil {
				clearClickStackSessionCookie(writer)
			}
			writer.Header().Set("Cache-Control", "no-store")
			http.Redirect(writer, request, backofficeEntryURL, http.StatusSeeOther)
			return
		}
		active, err := authorizer.Authorize(request.Context(), binding)
		if err != nil {
			writer.Header().Set("Cache-Control", "no-store")
			http.Error(writer, "Backoffice session validation is unavailable", http.StatusServiceUnavailable)
			return
		}
		if !active {
			clearClickStackSessionCookie(writer)
			writer.Header().Set("Cache-Control", "no-store")
			http.Redirect(writer, request, backofficeEntryURL, http.StatusSeeOther)
			return
		}
		next.ServeHTTP(writer, request)
	})
}

func checkClickStackReadiness(
	ctx context.Context,
	target *url.URL,
	config ClickStackGatewayConfig,
	transport http.RoundTripper,
) error {
	queryURL := *target
	query := queryURL.Query()
	query.Set("query", "SELECT 1 FROM otel.otel_logs LIMIT 1")
	queryURL.RawQuery = query.Encode()
	uiURL := *target
	uiURL.Path = "/clickstack"
	runtimeEnvironmentURL := *target
	runtimeEnvironmentURL.Path = clickStackRuntimeEnvPath

	probes := []struct {
		name      string
		url       url.URL
		bodyLimit int64
		validate  func(*http.Response, []byte) error
	}{
		{name: "query ClickHouse logs table", url: queryURL, bodyLimit: 1024},
		{name: "load ClickStack UI", url: uiURL, bodyLimit: clickStackReadinessBodyLimit, validate: validateClickStackUI},
		{name: "load ClickStack runtime environment", url: runtimeEnvironmentURL, bodyLimit: clickStackRuntimeEnvBodyLimit, validate: validateClickStackRuntimeEnvironment},
	}
	for _, probe := range probes {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, probe.url.String(), nil)
		if err != nil {
			return fmt.Errorf("build %s readiness request: %w", probe.name, err)
		}
		request.Header.Set("X-ClickHouse-User", config.Username)
		request.Header.Set("X-ClickHouse-Key", config.Password)
		response, err := transport.RoundTrip(request)
		if err != nil {
			return fmt.Errorf("%s: %w", probe.name, err)
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, probe.bodyLimit+1))
		closeErr := response.Body.Close()
		if readErr != nil {
			return fmt.Errorf("%s response: %w", probe.name, readErr)
		}
		if closeErr != nil {
			return fmt.Errorf("close %s response: %w", probe.name, closeErr)
		}
		if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
			return fmt.Errorf("%s: unexpected HTTP status %d", probe.name, response.StatusCode)
		}
		if int64(len(body)) > probe.bodyLimit {
			return fmt.Errorf("%s response exceeds %d bytes", probe.name, probe.bodyLimit)
		}
		if probe.validate != nil {
			if err := probe.validate(response, body); err != nil {
				return fmt.Errorf("%s: %w", probe.name, err)
			}
		}
	}
	return nil
}

func validateClickStackUI(response *http.Response, body []byte) error {
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || mediaType != "text/html" {
		return fmt.Errorf("expected text/html response")
	}
	for _, marker := range [][]byte{[]byte(">ClickStack</title>"), []byte(`id="__NEXT_DATA__"`), []byte(`"assetPrefix":"/clickstack"`)} {
		if !bytes.Contains(body, marker) {
			return fmt.Errorf("response is not the embedded ClickStack UI")
		}
	}
	return nil
}

func validateClickStackRuntimeEnvironment(response *http.Response, body []byte) error {
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || (mediaType != "application/javascript" && mediaType != "text/javascript") {
		return fmt.Errorf("expected JavaScript response")
	}
	for _, marker := range [][]byte{[]byte("window.__ENV"), []byte("NEXT_PUBLIC_IS_LOCAL_MODE")} {
		if !bytes.Contains(body, marker) {
			return fmt.Errorf("response is not the ClickStack runtime environment")
		}
	}
	return nil
}

func newClickStackTransport(responseHeaderTimeout time.Duration) *http.Transport {
	return &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   10,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   5 * time.Second,
		ExpectContinueTimeout: time.Second,
		ResponseHeaderTimeout: responseHeaderTimeout,
	}
}

func newClickStackGatewayServer(port int, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              fmt.Sprintf(":%d", port),
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      2 * time.Minute,
		IdleTimeout:       2 * time.Minute,
	}
}

func StartClickStackGateway(ctx context.Context, config ClickStackGatewayConfig) error {
	if config.Port == 0 {
		config.Port = clickStackGatewayDefaultPort
	}
	if config.Port < 1 || config.Port > 65535 {
		return fmt.Errorf("PROXY_PORT must be between 1 and 65535")
	}
	if _, err := validateClickStackGatewayConfig(config); err != nil {
		return err
	}
	redeemToken, err := currentClickStackRedeemToken(config.RedeemToken)
	if err != nil {
		return err
	}
	handler, err := newClickStackGatewayHandler(
		config,
		nil,
		newHTTPClickStackBackofficeClient(
			config.BackofficeRedeemURL,
			config.BackofficeIntrospectURL,
			redeemToken,
		),
	)
	if err != nil {
		return err
	}
	server := newClickStackGatewayServer(config.Port, handler)
	listener, err := net.Listen("tcp", server.Addr)
	if err != nil {
		return err
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.Serve(listener) }()
	slog.Info("ClickStack gateway is running", "port", config.Port)
	select {
	case err := <-serveErr:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		return server.Shutdown(shutdownCtx)
	}
}
