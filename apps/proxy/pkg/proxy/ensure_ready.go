// Copyright 2025 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"
)

const (
	// How long a request is held while a stopped box comes up. The API's own
	// resume window is 30s, but a browser (and anything in front of us) gives
	// up long before that, so answer with a retryable 503 first rather than
	// let the client time out on a blank page.
	ensureReadyHold = 20 * time.Second

	// Suppresses repeat calls for the same box once one has actually
	// succeeded: one page load is dozens of requests, and each would
	// otherwise ask the API to resume again. Written only after a success —
	// caching an in-flight call would report a resume that later timed out as
	// readiness, and every request for the rest of the window would skip the
	// retry it needed.
	//
	// Concurrent misses before that first success are therefore possible and
	// harmless: ensureReady takes the box's state-change lock and joins an
	// already-submitted start, so the API collapses them into one resume.
	ensureReadyDedupTTL = 30 * time.Second
)

// errEnsureReadyTimedOut is the one failure the caller renders differently: the
// resume is still in flight, so the request is retryable rather than broken.
var errEnsureReadyTimedOut = errors.New("box did not become ready in time")

// ensureBoxReady asks the API to resume the box if it is stopped, returning
// only once it is running.
//
// The call is idempotent and cheap for an already-running box, which is what
// makes it safe to issue without knowing the box's state — the proxy has no
// box state of its own, and adding a state lookup would cost the same round
// trip this call already makes.
//
// It sits on the preview controller, with the proxy's other calls, rather than
// on the product API — a wake RPC has no business in the spec-first v1/boxes
// surface the SDKs are generated from.
//
// The hold lives here rather than in the API: the endpoint waits out the
// resume for its own 30s, which outlasts what a browser (or anything in front
// of the proxy) will sit through, so the request context bounds it at 20s and
// the caller answers 503 first.
func (p *Proxy) ensureBoxReady(ctx context.Context, boxId string) error {
	if p.boxEnsureReadyCache != nil {
		recent, err := p.boxEnsureReadyCache.Has(ctx, boxId)
		if err != nil {
			slog.ErrorContext(ctx, "failed to check ensure-ready cache", "box", boxId, "error", err)
		} else if recent {
			return nil
		}
	}

	if p.apiclient == nil {
		return errors.New("no API client configured")
	}

	callCtx, cancel := context.WithTimeout(ctx, ensureReadyHold)
	defer cancel()

	response, err := p.apiclient.PreviewAPI.EnsureBoxReady(callCtx, boxId).Execute()
	if response != nil {
		defer response.Body.Close()
	}
	if err != nil && response == nil {
		// No response at all: a transport failure, or our own deadline. The
		// deadline means the box is still starting rather than that anything
		// is wrong, so keep that case retryable.
		if errors.Is(err, context.DeadlineExceeded) {
			return errEnsureReadyTimedOut
		}
		return err
	}

	switch {
	case response.StatusCode < 300:
		if p.boxEnsureReadyCache != nil {
			if err := p.boxEnsureReadyCache.Set(ctx, boxId, true, ensureReadyDedupTTL); err != nil {
				slog.ErrorContext(ctx, "failed to cache ensure-ready", "box", boxId, "error", err)
			}
		}
		return nil
	case response.StatusCode == http.StatusRequestTimeout, response.StatusCode == http.StatusGatewayTimeout:
		return errEnsureReadyTimedOut
	default:
		return fmt.Errorf("ensure-ready returned %d", response.StatusCode)
	}
}
