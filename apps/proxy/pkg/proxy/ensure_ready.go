// Copyright 2025 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"errors"
	"fmt"
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
// One page load is dozens of requests, so the call is de-duplicated — but only
// while it is in flight, never after it returns. A readiness answer kept for a
// fixed window is wrong the moment the box stops inside that window: every
// later request would skip the wake it needed and dial a stopped box, which is
// the bare 502 this path exists to remove. Nothing here outlives the call, so
// the proxy can never believe a box is up merely because it was up a moment
// ago.
func (p *Proxy) ensureBoxReady(ctx context.Context, boxId string) error {
	// Two lifetimes, deliberately separate. The shared call drops this
	// caller's cancellation, because the first arrival owns the request every
	// joiner is waiting on and a browser closing one tab must not cancel the
	// resume for the rest; it stays bounded by ensureReadyHold. Each caller
	// still leaves on its own ctx, so giving up on the wake costs the caller
	// its own deadline and nobody else's.
	shared := context.WithoutCancel(ctx)
	result := p.ensureReadyGroup.DoChan(boxId, func() (any, error) {
		return nil, p.doEnsureBoxReady(shared, boxId)
	})

	select {
	case outcome := <-result:
		return outcome.Err
	case <-ctx.Done():
		// The resume is still running for whoever else is waiting; from this
		// caller's side that is the same "still starting" a hold timeout
		// means, so it renders as the retryable 503 rather than a failure.
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return errEnsureReadyTimedOut
		}
		return ctx.Err()
	}
}

// doEnsureBoxReady is the single un-deduplicated call.
//
// Written against the generated client's configuration rather than a generated
// method: api-client-go is regenerated from the API's OpenAPI output, which
// needs a toolchain this change does not, so the typed method does not exist
// yet. Reusing GetConfig keeps the base URL, the proxy's Authorization header
// and the instrumented HTTP client in one place; swap this for
// PreviewAPI.EnsureBoxReady once the client catches up.
func (p *Proxy) doEnsureBoxReady(ctx context.Context, boxId string) error {
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
		return nil
	case response.StatusCode == http.StatusRequestTimeout, response.StatusCode == http.StatusGatewayTimeout:
		return errEnsureReadyTimedOut
	default:
		return fmt.Errorf("ensure-ready returned %d", response.StatusCode)
	}
}
