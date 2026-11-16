package attest

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"

	"google.golang.org/api/idtoken"
	"google.golang.org/api/option"
)

// TokenVerifier checks a Google token's signature, audience, and expiry and
// returns its claims. A rejected token is ErrInvalidProof; any other error means
// the verifier could not decide, for example because Google's keys were unreachable.
type TokenVerifier interface {
	Verify(ctx context.Context, token, audience string) (*idtoken.Payload, error)
}

// GoogleTokenVerifier verifies tokens with google.golang.org/api/idtoken,
// which caches Google's signing keys for their advertised lifetime.
type GoogleTokenVerifier struct {
	validator *idtoken.Validator
}

// NewGoogleTokenVerifier builds a verifier that fetches Google's keys through
// client, or through http.DefaultClient when client is nil.
func NewGoogleTokenVerifier(ctx context.Context, client *http.Client) (*GoogleTokenVerifier, error) {
	if client == nil {
		client = http.DefaultClient
	}
	tracked := *client
	base := tracked.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	tracked.Transport = outageTransport{base: base}
	validator, err := idtoken.NewValidator(ctx, option.WithHTTPClient(&tracked))
	if err != nil {
		return nil, fmt.Errorf("attest: build Google token validator: %w", err)
	}
	return &GoogleTokenVerifier{validator: validator}, nil
}

// Verify returns ErrInvalidProof for a bad token and a plain error when
// fetching Google's keys failed.
func (g *GoogleTokenVerifier) Verify(ctx context.Context, token, audience string) (*idtoken.Payload, error) {
	// idtoken v0.247.0 panics on a short ES256 signature, and instance identity
	// tokens are always RS256, so nothing else reaches the validator.
	if !signedRS256(token) {
		return nil, invalid(GCPIITName, "token is not RS256")
	}
	var outage atomic.Bool
	payload, err := g.validator.Validate(context.WithValue(ctx, outageKey{}, &outage), token, audience)
	switch {
	case err == nil:
		return payload, nil
	case outage.Load() || ctx.Err() != nil:
		return nil, fmt.Errorf("attest: fetch Google signing keys: %w", err)
	default:
		// A fixed reason: idtoken errors can quote token content.
		return nil, invalid(GCPIITName, "Google token rejected")
	}
}

func signedRS256(token string) bool {
	segment, _, _ := strings.Cut(token, ".")
	raw, err := base64.RawURLEncoding.DecodeString(segment)
	var header struct {
		Alg string `json:"alg"`
	}
	return err == nil && json.Unmarshal(raw, &header) == nil && header.Alg == "RS256"
}

type outageKey struct{}

// outageTransport marks the calling Verify when the key fetch fails, because
// idtoken reports a fetch failure and a bad signature with the same error type.
type outageTransport struct {
	base http.RoundTripper
}

func (t outageTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	flag, _ := r.Context().Value(outageKey{}).(*atomic.Bool)
	resp, err := t.base.RoundTrip(r)
	if flag == nil {
		return resp, err
	}
	if err != nil || resp.StatusCode != http.StatusOK {
		flag.Store(true)
		return resp, err
	}
	resp.Body = outageBody{ReadCloser: resp.Body, flag: flag}
	return resp, nil
}

// outageBody marks an outage when the key response breaks off mid-read.
type outageBody struct {
	io.ReadCloser
	flag *atomic.Bool
}

func (b outageBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if err != nil && err != io.EOF {
		b.flag.Store(true)
	}
	return n, err
}
