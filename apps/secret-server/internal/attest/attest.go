// Package attest decides which runner a Secret Server request came from.
//
// A runner proves its identity with a header that only that runner can
// produce, such as a Google-signed instance identity token. The request body
// is never consulted: Verify receives headers only.
package attest

import (
	"context"
	"errors"
	"fmt"
	"net/http"
)

// RunnerID identifies a runner as the API names it.
type RunnerID string

// ErrInvalidProof marks a proof that is missing, malformed, ambiguous, or
// rejected. Callers answer it with 401 attestation_failed. Any other error
// from Verify is a verifier outage, such as Google's keys being unreachable,
// and maps to 503 so the runner retries instead of reissuing its credential.
var ErrInvalidProof = errors.New("attest: invalid proof")

// Verifier returns the runner a request came from.
type Verifier interface {
	Verify(ctx context.Context, h http.Header) (RunnerID, error)
}

// Attestor is one proof method.
type Attestor interface {
	Verifier
	// Name is the mode used in configuration and the registry, such as "gcp_iit".
	Name() string
	// Header names the request header that carries this attestor's proof.
	Header() string
}

// Selector routes a request to the one enabled attestor whose proof header
// is present.
type Selector struct {
	attestors []Attestor
}

// NewSelector composes the enabled attestors into one Verifier.
func NewSelector(attestors ...Attestor) *Selector {
	return &Selector{attestors: attestors}
}

// Verify rejects a request with no proof header, or with proof headers for
// more than one enabled attestor. Headers of disabled attestors are ignored.
func (s *Selector) Verify(ctx context.Context, h http.Header) (RunnerID, error) {
	var chosen Attestor
	for _, a := range s.attestors {
		if h.Get(a.Header()) == "" {
			continue
		}
		if chosen != nil {
			return "", fmt.Errorf("%w: proofs for both %s and %s", ErrInvalidProof, chosen.Name(), a.Name())
		}
		chosen = a
	}
	if chosen == nil {
		return "", fmt.Errorf("%w: no proof header", ErrInvalidProof)
	}
	return chosen.Verify(ctx, h)
}

func invalid(attestor, reason string) error {
	return fmt.Errorf("%w: %s: %s", ErrInvalidProof, attestor, reason)
}
