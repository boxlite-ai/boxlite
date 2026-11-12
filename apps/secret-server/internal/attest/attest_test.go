package attest

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"strings"
	"testing"
	"time"

	"google.golang.org/api/idtoken"
)

const (
	testAudience = "https://secret-server.example.run.app"
	testProject  = "boxlite-staging"
	testAccount  = "runner@boxlite-staging.iam.gserviceaccount.com"
	testInstance = "4257000000000000001"
	testRunner   = RunnerID("rnr_a")
	testKeyID    = "test-key"
	testRegistry = `{"gcp_iit": {"4257000000000000001": "rnr_a"}}`
)

// fakeGoogle serves a JWKS for one local RSA key in place of Google's.
type fakeGoogle struct {
	key    *rsa.PrivateKey
	status int
	hits   int
}

func newFakeGoogle(t *testing.T) *fakeGoogle {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return &fakeGoogle{key: key, status: http.StatusOK}
}

func (f *fakeGoogle) RoundTrip(r *http.Request) (*http.Response, error) {
	f.hits++
	b64 := base64.RawURLEncoding.EncodeToString
	body, _ := json.Marshal(map[string]any{"keys": []map[string]string{{
		"kid": testKeyID, "kty": "RSA", "alg": "RS256", "use": "sig",
		"n": b64(f.key.N.Bytes()), "e": b64(big.NewInt(int64(f.key.E)).Bytes()),
	}}})
	return &http.Response{
		StatusCode: f.status,
		Header:     http.Header{"Content-Type": {"application/json"}},
		Body:       io.NopCloser(bytes.NewReader(body)),
		Request:    r,
	}, nil
}

// validClaims are what a registered runner VM's format=full token carries.
func validClaims() map[string]any {
	now := time.Now()
	return map[string]any{
		"iss":            "https://accounts.google.com",
		"aud":            testAudience,
		"iat":            now.Unix(),
		"exp":            now.Add(time.Hour).Unix(),
		"sub":            "1100000000000000000",
		"email":          testAccount,
		"email_verified": true,
		"google": map[string]any{"compute_engine": map[string]any{
			"project_id": testProject, "instance_id": testInstance, "zone": "us-central1-a",
		}},
	}
}

func sign(t *testing.T, key *rsa.PrivateKey, alg string, claims map[string]any) string {
	t.Helper()
	enc := func(v any) string {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return base64.RawURLEncoding.EncodeToString(b)
	}
	signed := enc(map[string]string{"alg": alg, "kid": testKeyID, "typ": "JWT"}) + "." + enc(claims)
	digest := sha256.Sum256([]byte(signed))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return signed + "." + base64.RawURLEncoding.EncodeToString(sig)
}

type harness struct {
	google *fakeGoogle
	sel    *Selector
	logs   *bytes.Buffer
}

func newHarness(t *testing.T, attestors []string, env, registry string) (*harness, error) {
	t.Helper()
	google := newFakeGoogle(t)
	tokens, err := NewGoogleTokenVerifier(context.Background(), &http.Client{Transport: google})
	if err != nil {
		t.Fatal(err)
	}
	logs := &bytes.Buffer{}
	sel, err := New(Config{
		Attestors:   attestors,
		Environment: env,
		GCPIIT:      GCPIITConfig{Audience: testAudience, Project: testProject, ServiceAccount: testAccount},
		Registry:    registry,
	}, tokens, slog.New(slog.NewTextHandler(logs, nil)))
	return &harness{google: google, sel: sel, logs: logs}, err
}

func mustHarness(t *testing.T) *harness {
	t.Helper()
	h, err := newHarness(t, []string{GCPIITName}, "staging", testRegistry)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func identity(token string) http.Header {
	return http.Header{GCPIITHeader: {token}, "Authorization": {"Bearer " + token}}
}

func TestGCPIITAcceptsRegisteredInstance(t *testing.T) {
	h := mustHarness(t)
	got, err := h.sel.Verify(context.Background(), identity(sign(t, h.google.key, "RS256", validClaims())))
	if err != nil || got != testRunner {
		t.Fatalf("Verify = %q, %v; want %q", got, err, testRunner)
	}
}

func TestGCPIITRejectsInvalidProofs(t *testing.T) {
	h := mustHarness(t)
	otherKey := newFakeGoogle(t).key
	cases := []struct {
		name   string
		key    *rsa.PrivateKey
		alg    string
		mutate func(map[string]any)
	}{
		{name: "signed by another key", key: otherKey},
		{name: "HS256 algorithm", alg: "HS256"},
		{name: "wrong audience", mutate: func(c map[string]any) { c["aud"] = "https://other.example" }},
		{name: "wrong issuer", mutate: func(c map[string]any) { c["iss"] = "https://evil.example" }},
		{name: "expired", mutate: func(c map[string]any) { c["exp"] = time.Now().Add(-time.Minute).Unix() }},
		{name: "issued 5 minutes ahead", mutate: func(c map[string]any) { c["iat"] = time.Now().Add(5 * time.Minute).Unix() }},
		{name: "API service account", mutate: func(c map[string]any) { c["email"] = "api@boxlite-staging.iam.gserviceaccount.com" }},
		{name: "email not verified", mutate: func(c map[string]any) { c["email_verified"] = false }},
		{name: "not a Compute Engine VM", mutate: func(c map[string]any) { delete(c, "google") }},
		{name: "other project", mutate: func(c map[string]any) {
			c["google"].(map[string]any)["compute_engine"].(map[string]any)["project_id"] = "other-project"
		}},
		{name: "unregistered instance", mutate: func(c map[string]any) {
			c["google"].(map[string]any)["compute_engine"].(map[string]any)["instance_id"] = "999"
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			claims := validClaims()
			if tc.mutate != nil {
				tc.mutate(claims)
			}
			key, alg := h.google.key, "RS256"
			if tc.key != nil {
				key = tc.key
			}
			if tc.alg != "" {
				alg = tc.alg
			}
			got, err := h.sel.Verify(context.Background(), identity(sign(t, key, alg, claims)))
			if !errors.Is(err, ErrInvalidProof) || got != "" {
				t.Fatalf("Verify = %q, %v; want ErrInvalidProof", got, err)
			}
		})
	}
}

func TestGCPIITIssuedAtWithinSkewAccepted(t *testing.T) {
	h := mustHarness(t)
	claims := validClaims()
	claims["iat"] = time.Now().Add(30 * time.Second).Unix()
	if _, err := h.sel.Verify(context.Background(), identity(sign(t, h.google.key, "RS256", claims))); err != nil {
		t.Fatalf("iat 30s ahead rejected: %v", err)
	}
}

func TestGCPIITIgnoresInstanceRegisteredUnderAnotherMode(t *testing.T) {
	h, err := newHarness(t, []string{GCPIITName}, "staging", `{"dev": {"4257000000000000001": "rnr_a"}}`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.sel.Verify(context.Background(), identity(sign(t, h.google.key, "RS256", validClaims())))
	if !errors.Is(err, ErrInvalidProof) {
		t.Fatalf("Verify err = %v; want ErrInvalidProof", err)
	}
}

func TestKeyFetchFailureIsAnOutage(t *testing.T) {
	h := mustHarness(t)
	h.google.status = http.StatusInternalServerError
	got, err := h.sel.Verify(context.Background(), identity(sign(t, h.google.key, "RS256", validClaims())))
	if err == nil || errors.Is(err, ErrInvalidProof) || got != "" {
		t.Fatalf("Verify = %q, %v; want a non-ErrInvalidProof error", got, err)
	}
	if h.google.hits == 0 {
		t.Fatal("the fake key endpoint was never called")
	}
}

func TestSelector(t *testing.T) {
	both, err := newHarness(t, []string{GCPIITName, DevName}, "local", testRegistry)
	if err != nil {
		t.Fatal(err)
	}
	gcpOnly := mustHarness(t)
	devOnly, err := newHarness(t, []string{DevName}, "dev", "")
	if err != nil {
		t.Fatal(err)
	}
	valid := sign(t, both.google.key, "RS256", validClaims())
	cases := []struct {
		name string
		sel  *Selector
		h    http.Header
	}{
		{"no proof header", both.sel, http.Header{"Authorization": {"Bearer " + valid}}},
		{"both proof headers", both.sel, http.Header{GCPIITHeader: {valid}, DevHeader: {"rnr_b"}}},
		{"gcp_iit disabled", devOnly.sel, identity(sign(t, devOnly.google.key, "RS256", validClaims()))},
		{"dev disabled", gcpOnly.sel, http.Header{DevHeader: {"rnr_b"}}},
		{"dev claims a gcp_iit runner", both.sel, http.Header{DevHeader: {string(testRunner)}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got, err := tc.sel.Verify(context.Background(), tc.h); !errors.Is(err, ErrInvalidProof) || got != "" {
				t.Fatalf("Verify = %q, %v; want ErrInvalidProof", got, err)
			}
		})
	}
	if got, err := devOnly.sel.Verify(context.Background(), http.Header{DevHeader: {"rnr_b"}}); err != nil || got != "rnr_b" {
		t.Fatalf("dev Verify = %q, %v; want rnr_b", got, err)
	}
}

func TestNewRejectsBadConfiguration(t *testing.T) {
	cases := []struct {
		name      string
		attestors []string
		env       string
		registry  string
	}{
		{"no attestors", nil, "staging", testRegistry},
		{"unknown attestor", []string{"aws_iid"}, "staging", testRegistry},
		{"duplicate attestor", []string{GCPIITName, GCPIITName}, "staging", testRegistry},
		{"dev on staging", []string{DevName}, "staging", ""},
		{"dev on production", []string{DevName}, "production", ""},
		{"invalid registry JSON", []string{GCPIITName}, "staging", `{"gcp_iit": [`},
		{"unknown registry mode", []string{GCPIITName}, "staging", `{"aws_iid": {"i-1": "rnr_a"}}`},
		{"empty instance ID", []string{GCPIITName}, "staging", `{"gcp_iit": {"": "rnr_a"}}`},
		{"empty runner ID", []string{GCPIITName}, "staging", `{"gcp_iit": {"1": ""}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := newHarness(t, tc.attestors, tc.env, tc.registry); err == nil {
				t.Fatal("New succeeded; want a startup error")
			}
		})
	}
	if _, err := New(Config{Attestors: []string{GCPIITName}, Environment: "staging", GCPIIT: GCPIITConfig{Audience: testAudience}},
		newFakeVerifier(), slog.New(slog.DiscardHandler)); err == nil {
		t.Fatal("gcp_iit without project and service account accepted")
	}
}

func TestNewWarnsAboutUnusableRegistry(t *testing.T) {
	h, err := newHarness(t, []string{GCPIITName}, "staging", `{"dev": {"x": "rnr_a"}}`)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"no gcp_iit instances", "disabled attestor"} {
		if !strings.Contains(h.logs.String(), want) {
			t.Errorf("logs %q lack warning %q", h.logs.String(), want)
		}
	}
}

func TestRejectionsNeverEchoTheToken(t *testing.T) {
	h := mustHarness(t)
	const marker = "MARKER-7f3a"
	claims := validClaims()
	claims["email"] = marker + "@example.com"
	claims["sub"] = marker
	token := sign(t, h.google.key, "RS256", claims)
	_, err := h.sel.Verify(context.Background(), identity(token))
	if !errors.Is(err, ErrInvalidProof) {
		t.Fatalf("Verify err = %v; want ErrInvalidProof", err)
	}
	for _, text := range []string{err.Error(), h.logs.String()} {
		if strings.Contains(text, marker) || strings.Contains(text, token) {
			t.Fatalf("token content leaked: %q", text)
		}
	}
}

// fakeVerifier satisfies TokenVerifier for configuration tests that never verify.
type fakeVerifier struct{}

func newFakeVerifier() TokenVerifier { return fakeVerifier{} }

func (fakeVerifier) Verify(context.Context, string, string) (*idtoken.Payload, error) {
	return nil, errors.New("unused")
}
