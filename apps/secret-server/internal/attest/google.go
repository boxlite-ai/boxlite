package attest

import (
	"context"
	"fmt"
	"net/http"
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
	var outage atomic.Bool
	payload, err := g.validator.Validate(context.WithValue(ctx, outageKey{}, &outage), token, audience)
	switch {
	case err == nil:
		return payload, nil
	case outage.Load() || ctx.Err() != nil:
		return nil, fmt.Errorf("attest: fetch Google signing keys: %w", err)
	default:
		// idtoken messages describe the token's shape and times, never its content.
		return nil, fmt.Errorf("%w: %v", ErrInvalidProof, err)
	}
}

type outageKey struct{}

// outageTransport marks the calling Verify when the key fetch fails, because
// idtoken reports a fetch failure and a bad signature with the same error type.
type outageTransport struct {
	base http.RoundTripper
}

func (t outageTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	resp, err := t.base.RoundTrip(r)
	if err != nil || resp.StatusCode != http.StatusOK {
		if flag, ok := r.Context().Value(outageKey{}).(*atomic.Bool); ok {
			flag.Store(true)
		}
	}
	return resp, err
}
