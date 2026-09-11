// Copyright 2025 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
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
// Written against the generated client's configuration rather than a generated
// method: api-client-go is regenerated from the API's OpenAPI output, which
// needs a toolchain this change does not, so the typed method does not exist
// yet. Reusing GetConfig keeps the base URL, the proxy's Authorization header
// and the instrumented HTTP client in one place; swap this for
// PreviewAPI.EnsureBoxReady once the client catches up.
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
	cfg := p.apiclient.GetConfig()
	if len(cfg.Servers) == 0 {
		return errors.New("no API server configured")
	}
	url := fmt.Sprintf("%s/preview/%s/ensure-ready", strings.TrimRight(cfg.Servers[0].URL, "/"), boxId)

	callCtx, cancel := context.WithTimeout(ctx, ensureReadyHold)
	defer cancel()

	request, err := http.NewRequestWithContext(callCtx, http.MethodPost, url, nil)
	if err != nil {
		return err
	}
	for key, value := range cfg.DefaultHeader {
		request.Header.Set(key, value)
	}

	client := cfg.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		// A deadline here means the box is still starting, not that the
		// request was malformed — keep it retryable.
		if errors.Is(err, context.DeadlineExceeded) {
			return errEnsureReadyTimedOut
		}
		return err
	}
	defer response.Body.Close()

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
