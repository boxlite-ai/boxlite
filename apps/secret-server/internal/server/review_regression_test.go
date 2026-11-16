package server

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"google.golang.org/api/idtoken"
	"google.golang.org/api/option"
)

func TestWriteAuthRejectsShortES256Signature(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	encode := base64.RawURLEncoding.EncodeToString
	jwks, err := json.Marshal(map[string]any{"keys": []any{map[string]string{
		"kty": "EC", "crv": "P-256", "kid": "test-key", "alg": "ES256",
		"x": encode(key.X.FillBytes(make([]byte, 32))), "y": encode(key.Y.FillBytes(make([]byte, 32))),
	}}})
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(jwks))), Request: r}, nil
	})}
	validator, err := idtoken.NewValidator(context.Background(), option.WithHTTPClient(client))
	if err != nil {
		t.Fatal(err)
	}
	header, _ := json.Marshal(map[string]string{"alg": "ES256", "kid": "test-key"})
	claims, _ := json.Marshal(map[string]any{"aud": "audience", "exp": time.Now().Add(time.Hour).Unix()})
	for _, length := range []int{0, 1, 31, 32} {
		t.Run(fmt.Sprintf("signature-%d-bytes", length), func(t *testing.T) {
			token := encode(header) + "." + encode(claims) + "." + encode(make([]byte, length))
			called := false
			handler := writeAuth(Config{AuthMode: "google", Audience: "audience"}, validator.Validate, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
			req := httptest.NewRequest(http.MethodPost, "/", nil)
			req.Header.Set("Authorization", "Bearer "+token)
			response := httptest.NewRecorder()
			defer func() {
				if value := recover(); value != nil {
					t.Errorf("malformed signature panicked: %v", value)
				}
			}()
			handler.ServeHTTP(response, req)
			if response.Code != http.StatusUnauthorized || called {
				t.Fatalf("status = %d, handler called = %v", response.Code, called)
			}
		})
	}
	validClaims, _ := json.Marshal(map[string]any{"aud": "audience", "exp": time.Now().Add(time.Hour).Unix(), "iss": "https://accounts.google.com", "email": "allowed@example.invalid", "email_verified": true})
	signingInput := encode(header) + "." + encode(validClaims)
	digest := sha256.Sum256([]byte(signingInput))
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	signature := append(r.FillBytes(make([]byte, 32)), s.FillBytes(make([]byte, 32))...)
	called := false
	handler := writeAuth(Config{AuthMode: "google", Audience: "audience", AllowedCallers: []string{"allowed@example.invalid"}}, validator.Validate, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { called = true; w.WriteHeader(http.StatusNoContent) }))
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	req.Header.Set("Authorization", "Bearer "+signingInput+"."+encode(signature))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != http.StatusNoContent || !called {
		t.Fatalf("valid ES256: status = %d, handler called = %v", response.Code, called)
	}
}

func TestLoadConfigRejectsPortZero(t *testing.T) {
	for name, value := range map[string]string{"SECRET_SERVER_ROLE": "write", "ENVIRONMENT": "local", "DATABASE_URL": "postgres://localhost/test", "SECRET_MASTER_KEY_ID": "env:test", "SECRET_MASTER_KEY_BASE64": "key", "SECRET_SERVER_AUTH_MODE": "dev", "SECRET_SERVER_DEV_TOKEN": "token", "SECRET_SERVER_AUDIENCE": "", "SECRET_SERVER_ALLOWED_CALLERS": "", "PORT": "0", "SHUTDOWN_TIMEOUT_SEC": ""} {
		t.Setenv(name, value)
	}
	_, err := LoadConfig()
	if err == nil || !strings.Contains(err.Error(), "PORT") {
		t.Fatalf("PORT=0: error = %v, want PORT error", err)
	}
}
