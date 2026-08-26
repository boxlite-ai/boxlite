// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
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
	clickStackGatewayDefaultPort    = 4000
	clickStackReadinessTimeout      = 3 * time.Second
	clickStackReadinessBodyLimit    = 1 << 20
	clickStackRuntimeEnvBodyLimit   = 64 << 10
	clickStackRuntimeEnvPath        = "/clickstack/__ENV.js"
	clickStackResponseHeaderTimeout = 30 * time.Second
	clickStackHandoffBodyLimit      = 2 << 10
	clickStackHandoffRateLimit      = 20
	clickStackHandoffMaxInFlight    = 8
	clickStackRedeemBodyLimit       = 1 << 10
	clickStackSessionTTL            = 5 * time.Minute
	clickStackSessionCookie         = "__Host-boxlite_clickstack"
)

var clickStackHandoffCodePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

type ClickStackGatewayConfig struct {
	UpstreamURL         string
	Username            string
	Password            string
	Port                int
	BackofficeRedeemURL string
	BackofficeEntryURL  string
	RedeemToken         string
	SessionKeys         string
}

type clickStackGrantRedeemer interface {
	Redeem(context.Context, string) error
}

type httpClickStackGrantRedeemer struct {
	url    string
	token  string
	client *http.Client
}

type clickStackSessionManager struct {
	current  []byte
	previous []byte
	now      func() time.Time
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
		UpstreamURL:         os.Getenv("CLICKSTACK_UPSTREAM_URL"),
		Username:            os.Getenv("CLICKSTACK_USERNAME"),
		Password:            os.Getenv("CLICKSTACK_PASSWORD"),
		Port:                port,
		BackofficeRedeemURL: os.Getenv("CLICKSTACK_BACKOFFICE_REDEEM_URL"),
		BackofficeEntryURL:  os.Getenv("CLICKSTACK_BACKOFFICE_ENTRY_URL"),
		RedeemToken:         os.Getenv("CLICKSTACK_REDEEM_TOKEN"),
		SessionKeys:         os.Getenv("CLICKSTACK_SESSION_KEYS"),
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
	if _, err := cleanClickStackPublicURL(config.BackofficeRedeemURL, "CLICKSTACK_BACKOFFICE_REDEEM_URL"); err != nil {
		return nil, err
	}
	if _, err := cleanClickStackPublicURL(config.BackofficeEntryURL, "CLICKSTACK_BACKOFFICE_ENTRY_URL"); err != nil {
		return nil, err
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

func (sessions *clickStackSessionManager) Issue() (*http.Cookie, error) {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("create ClickStack session nonce: %w", err)
	}
	expires := sessions.now().Add(clickStackSessionTTL)
	payload := fmt.Sprintf("v1.%d.%s", expires.Unix(), base64.RawURLEncoding.EncodeToString(nonce))
	value := payload + "." + signClickStackSession(payload, sessions.current)
	return &http.Cookie{
		Name:     clickStackSessionCookie,
		Value:    value,
		Path:     "/",
		Expires:  expires,
		MaxAge:   int(clickStackSessionTTL.Seconds()),
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	}, nil
}

func (sessions *clickStackSessionManager) Verify(value string) bool {
	parts := strings.Split(value, ".")
	if len(parts) != 4 || parts[0] != "v1" {
		return false
	}
	expiresUnix, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return false
	}
	now := sessions.now()
	expires := time.Unix(expiresUnix, 0)
	if !expires.After(now) || expires.After(now.Add(clickStackSessionTTL+time.Second)) {
		return false
	}
	if nonce, err := base64.RawURLEncoding.DecodeString(parts[2]); err != nil || len(nonce) != 16 {
		return false
	}
	payload := strings.Join(parts[:3], ".")
	provided, err := base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil {
		return false
	}
	for _, key := range [][]byte{sessions.current, sessions.previous} {
		if len(key) == 0 {
			continue
		}
		expected, _ := base64.RawURLEncoding.DecodeString(signClickStackSession(payload, key))
		if hmac.Equal(provided, expected) {
			return true
		}
	}
	return false
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

func newHTTPClickStackGrantRedeemer(redeemURL, redeemToken string) *httpClickStackGrantRedeemer {
	return &httpClickStackGrantRedeemer{
		url:   redeemURL,
		token: redeemToken,
		client: &http.Client{
			Transport: newClickStackTransport(5 * time.Second),
			Timeout:   5 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

func (redeemer *httpClickStackGrantRedeemer) Redeem(ctx context.Context, code string) error {
	body, err := json.Marshal(map[string]string{"code": code})
	if err != nil {
		return errors.New("encode Backoffice handoff")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, redeemer.url, bytes.NewReader(body))
	if err != nil {
		return errors.New("build Backoffice handoff request")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+redeemer.token)
	response, err := redeemer.client.Do(request)
	if err != nil {
		return errors.New("Backoffice handoff service is unavailable")
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, clickStackRedeemBodyLimit+1))
	if err != nil || len(responseBody) > clickStackRedeemBodyLimit || response.StatusCode != http.StatusOK {
		return errors.New("Backoffice handoff was rejected")
	}
	var result struct {
		Active bool `json:"active"`
	}
	decoder := json.NewDecoder(bytes.NewReader(responseBody))
	if err := decoder.Decode(&result); err != nil || decoder.Decode(&struct{}{}) != io.EOF || !result.Active {
		return errors.New("Backoffice handoff was rejected")
	}
	return nil
}

func newClickStackGatewayHandler(
	config ClickStackGatewayConfig,
	transport http.RoundTripper,
	redeemer clickStackGrantRedeemer,
) (http.Handler, error) {
	target, err := validateClickStackGatewayConfig(config)
	if err != nil {
		return nil, err
	}
	if redeemer == nil {
		return nil, fmt.Errorf("ClickStack handoff redeemer is required")
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
			redeemer,
			handoffLimiter,
		)
	})
	mux.Handle("/", requireClickStackSession(sessions, config.BackofficeEntryURL, reverseProxy))
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
	redeemer clickStackGrantRedeemer,
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
	if err := redeemer.Redeem(request.Context(), code); err != nil {
		http.Error(writer, "ClickStack handoff was rejected", http.StatusUnauthorized)
		return
	}
	cookie, err := sessions.Issue()
	if err != nil {
		http.Error(writer, "ClickStack session is unavailable", http.StatusServiceUnavailable)
		return
	}
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Referrer-Policy", "no-referrer")
	http.SetCookie(writer, cookie)
	http.Redirect(writer, request, "/clickstack", http.StatusSeeOther)
}

func requireClickStackSession(
	sessions *clickStackSessionManager,
	backofficeEntryURL string,
	next http.Handler,
) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		cookie, err := request.Cookie(clickStackSessionCookie)
		if err != nil || !sessions.Verify(cookie.Value) {
			if err == nil {
				clearClickStackSessionCookie(writer)
			}
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
		newHTTPClickStackGrantRedeemer(config.BackofficeRedeemURL, redeemToken),
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
