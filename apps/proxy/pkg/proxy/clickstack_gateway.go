// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
)

const clickStackGatewayDefaultPort = 4000

type ClickStackGatewayConfig struct {
	UpstreamURL      string
	Username         string
	Password         string
	Port             int
	OIDCIssuer       string
	OIDCAudience     string
	OIDCRoleClaim    string
	OIDCAllowedRoles []string
}

type clickStackTokenVerifier interface {
	Verify(context.Context, string) error
}

type oidcClickStackTokenVerifier struct {
	verifier     *oidc.IDTokenVerifier
	roleClaim    string
	allowedRoles map[string]struct{}
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
		UpstreamURL:      os.Getenv("CLICKSTACK_UPSTREAM_URL"),
		Username:         os.Getenv("CLICKSTACK_USERNAME"),
		Password:         os.Getenv("CLICKSTACK_PASSWORD"),
		Port:             port,
		OIDCIssuer:       os.Getenv("CLICKSTACK_OIDC_ISSUER"),
		OIDCAudience:     os.Getenv("CLICKSTACK_OIDC_AUDIENCE"),
		OIDCRoleClaim:    os.Getenv("CLICKSTACK_OIDC_ROLE_CLAIM"),
		OIDCAllowedRoles: splitCommaSeparated(os.Getenv("CLICKSTACK_OIDC_ALLOWED_ROLE_VALUES")),
	}, nil
}

func splitCommaSeparated(value string) []string {
	var values []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			values = append(values, item)
		}
	}
	return values
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
	issuer, err := url.Parse(config.OIDCIssuer)
	if err != nil || issuer.Scheme != "https" || issuer.Host == "" || issuer.User != nil || issuer.RawQuery != "" || issuer.Fragment != "" {
		return nil, fmt.Errorf("CLICKSTACK_OIDC_ISSUER must be a clean HTTPS URL")
	}
	if config.OIDCAudience == "" {
		return nil, fmt.Errorf("CLICKSTACK_OIDC_AUDIENCE is required")
	}
	if config.OIDCRoleClaim == "" {
		return nil, fmt.Errorf("CLICKSTACK_OIDC_ROLE_CLAIM is required")
	}
	if len(config.OIDCAllowedRoles) == 0 {
		return nil, fmt.Errorf("CLICKSTACK_OIDC_ALLOWED_ROLE_VALUES must contain at least one role")
	}
	return target, nil
}

func newClickStackGatewayHandler(
	config ClickStackGatewayConfig,
	transport http.RoundTripper,
	verifier clickStackTokenVerifier,
) (http.Handler, error) {
	target, err := validateClickStackGatewayConfig(config)
	if err != nil {
		return nil, err
	}
	if verifier == nil {
		return nil, fmt.Errorf("ClickStack token verifier is required")
	}

	reverseProxy := &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(target)
			request.Out.Host = target.Host

			query := request.Out.URL.Query()
			query.Del("user")
			query.Del("password")
			request.Out.URL.RawQuery = query.Encode()

			for _, header := range []string{
				"Authorization",
				"Cookie",
				"X-Amzn-Oidc-Accesstoken",
				"X-Amzn-Oidc-Data",
				"X-Amzn-Oidc-Identity",
				"X-ClickHouse-User",
				"X-ClickHouse-Key",
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

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write([]byte(`{"status":"ok"}`))
	})
	mux.Handle("/", http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		accessToken := request.Header.Get("X-Amzn-Oidc-Accesstoken")
		if accessToken == "" {
			http.Error(writer, "employee authentication is required", http.StatusUnauthorized)
			return
		}
		if err := verifier.Verify(request.Context(), accessToken); err != nil {
			http.Error(writer, "operator access is not granted", http.StatusForbidden)
			return
		}
		reverseProxy.ServeHTTP(writer, request)
	}))
	return mux, nil
}

func newOIDCClickStackTokenVerifier(ctx context.Context, config ClickStackGatewayConfig) (clickStackTokenVerifier, error) {
	provider, err := oidc.NewProvider(ctx, config.OIDCIssuer)
	if err != nil {
		return nil, fmt.Errorf("discover ClickStack OIDC provider: %w", err)
	}
	allowedRoles := make(map[string]struct{}, len(config.OIDCAllowedRoles))
	for _, role := range config.OIDCAllowedRoles {
		allowedRoles[role] = struct{}{}
	}
	return &oidcClickStackTokenVerifier{
		verifier:     provider.Verifier(&oidc.Config{ClientID: config.OIDCAudience}),
		roleClaim:    config.OIDCRoleClaim,
		allowedRoles: allowedRoles,
	}, nil
}

func (verifier *oidcClickStackTokenVerifier) Verify(ctx context.Context, rawToken string) error {
	token, err := verifier.verifier.Verify(ctx, rawToken)
	if err != nil {
		return errors.New("invalid employee access token")
	}
	var claims map[string]any
	if err := token.Claims(&claims); err != nil {
		return errors.New("invalid employee access token claims")
	}
	return authorizeClickStackClaims(claims, verifier.roleClaim, verifier.allowedRoles)
}

func authorizeClickStackClaims(claims map[string]any, roleClaim string, allowedRoles map[string]struct{}) error {
	if !hasScope(claims, "boxlite-backoffice") {
		return errors.New("employee access token is missing the backoffice scope")
	}
	for _, role := range claimStrings(claims[roleClaim]) {
		if _, allowed := allowedRoles[role]; allowed {
			return nil
		}
	}
	return errors.New("employee role is not allowed")
}

func hasScope(claims map[string]any, expected string) bool {
	for _, key := range []string{"scope", "scp"} {
		for _, scope := range claimStrings(claims[key]) {
			for _, value := range strings.Fields(scope) {
				if value == expected {
					return true
				}
			}
		}
	}
	return false
}

func claimStrings(value any) []string {
	switch value := value.(type) {
	case string:
		return []string{value}
	case []any:
		values := make([]string, 0, len(value))
		for _, item := range value {
			if text, ok := item.(string); ok {
				values = append(values, text)
			}
		}
		return values
	default:
		return nil
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
	verifier, err := newOIDCClickStackTokenVerifier(ctx, config)
	if err != nil {
		return err
	}
	handler, err := newClickStackGatewayHandler(config, nil, verifier)
	if err != nil {
		return err
	}
	server := &http.Server{
		Addr:              fmt.Sprintf(":%d", config.Port),
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}
	listener, err := net.Listen("tcp", server.Addr)
	if err != nil {
		return err
	}

	serveErr := make(chan error, 1)
	go func() {
		serveErr <- server.Serve(listener)
	}()
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
