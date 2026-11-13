package server

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"google.golang.org/api/idtoken"
	"google.golang.org/api/option"
)

type transport func(*http.Request) (*http.Response, error)

func (f transport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestWriteAuthentication(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	encode := base64.RawURLEncoding.EncodeToString
	jwks, _ := json.Marshal(map[string]any{"keys": []any{map[string]string{"kty": "RSA", "kid": "local", "alg": "RS256", "n": encode(key.N.Bytes()), "e": encode(big.NewInt(int64(key.E)).Bytes())}}})
	var calls int
	client := &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 200, Header: http.Header{"Cache-Control": []string{"max-age=60"}}, Body: io.NopCloser(strings.NewReader(string(jwks))), Request: r}, nil
	})}
	v, err := idtoken.NewValidator(context.Background(), option.WithHTTPClient(client))
	if err != nil {
		t.Fatal(err)
	}
	c := Config{AuthMode: "google", Audience: "test-audience", AllowedCallers: []string{"allowed@example.invalid"}}
	tests := []struct {
		name   string
		change func(map[string]any)
		want   int
	}{
		{"valid", func(map[string]any) {}, 200},
		{"alternate issuer", func(c map[string]any) { c["iss"] = "accounts.google.com" }, 200},
		{"issuer", func(c map[string]any) { c["iss"] = "https://invalid.example" }, 401},
		{"unverified", func(c map[string]any) { c["email_verified"] = false }, 401},
		{"untyped verification", func(c map[string]any) { c["email_verified"] = "true" }, 401},
		{"missing email", func(c map[string]any) { delete(c, "email") }, 401},
		{"not allowed", func(c map[string]any) { c["email"] = "other@example.invalid" }, 401},
		{"audience", func(c map[string]any) { c["aud"] = "wrong" }, 401},
		{"expired", func(c map[string]any) { c["exp"] = time.Now().Add(-time.Hour).Unix() }, 401},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			claims := map[string]any{"iss": "https://accounts.google.com", "aud": "test-audience", "exp": time.Now().Add(time.Hour).Unix(), "email": "allowed@example.invalid", "email_verified": true}
			tc.change(claims)
			payload, _ := json.Marshal(claims)
			head := encode([]byte(`{"alg":"RS256","kid":"local"}`))
			body := encode(payload)
			sum := sha256.Sum256([]byte(head + "." + body))
			signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
			if err != nil {
				t.Fatal(err)
			}
			called := false
			handler := writeAuth(c, v.Validate, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { called = true; w.WriteHeader(200) }))
			r := httptest.NewRequest("POST", "/", nil)
			r.Header.Set("Authorization", "Bearer "+head+"."+body+"."+encode(signature))
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tc.want || called != (tc.want == 200) {
				t.Fatalf("status %d called %v", w.Code, called)
			}
		})
	}
	if calls == 0 {
		t.Fatal("custom JWKS transport was not used")
	}
}

func TestWriteAuthenticationRejectsMissingAndInvalidTokens(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	encode := base64.RawURLEncoding.EncodeToString
	jwks, _ := json.Marshal(map[string]any{"keys": []any{map[string]string{"kty": "RSA", "kid": "local", "alg": "RS256", "n": encode(key.N.Bytes()), "e": encode(big.NewInt(int64(key.E)).Bytes())}}})
	client := &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(jwks))), Request: r}, nil
	})}
	v, err := idtoken.NewValidator(context.Background(), option.WithHTTPClient(client))
	if err != nil {
		t.Fatal(err)
	}
	other, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	claims, _ := json.Marshal(map[string]any{"iss": "accounts.google.com", "aud": "aud", "exp": time.Now().Add(time.Hour).Unix(), "email": "allowed@example.invalid", "email_verified": true})
	header := encode([]byte(`{"alg":"RS256","kid":"local"}`))
	body := encode(claims)
	hash := sha256.Sum256([]byte(header + "." + body))
	sig, err := rsa.SignPKCS1v15(rand.Reader, other, crypto.SHA256, hash[:])
	if err != nil {
		t.Fatal(err)
	}
	for _, token := range []string{"", "Bearer " + header + "." + body + "." + encode(sig)} {
		called := false
		handler := writeAuth(Config{AuthMode: "google", Audience: "aud", AllowedCallers: []string{"allowed@example.invalid"}}, v.Validate, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
		r := httptest.NewRequest("POST", "/", nil)
		if token != "" {
			r.Header.Set("Authorization", token)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized || called {
			t.Fatalf("status %d called %v", w.Code, called)
		}
	}
}

func TestDevTokenRequiresExactBearer(t *testing.T) {
	for _, tc := range []struct {
		header string
		want   int
	}{{"Bearer secret", 204}, {"Bearer wrong", 401}, {"Bearer sec", 401}, {"Bearer secret-extra", 401}, {"Basic secret", 401}, {"secret", 401}} {
		called := false
		handler := writeAuth(Config{AuthMode: "dev", DevToken: "secret"}, nil, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { called = true; w.WriteHeader(204) }))
		r := httptest.NewRequest("POST", "/", nil)
		r.Header.Set("Authorization", tc.header)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != tc.want || called != (tc.want == 204) {
			t.Fatalf("header %q: %d called %v", tc.header, w.Code, called)
		}
	}
}
