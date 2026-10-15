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
	"net/url"
	"time"

	common_errors "github.com/boxlite-ai/common-go/pkg/errors"
)

// A stopped box's first request should succeed when the box and its service
// come up within guestWakeBudget. Past that, the client gets 503 + Retry-After
// while the start continues in the background. It matches the API's
// AUTO_RESUME_TIMEOUT_SECONDS, the time the API waits for a box to start.
var guestWakeBudget = 30 * time.Second

const (
	guestDialRetryInterval = 500 * time.Millisecond
	boxStartingRetryAfter  = "3"
	runnerBoxNotRunning    = "box_not_running"
)

var (
	errBoxStarting    = common_errors.NewCustomError(http.StatusServiceUnavailable, "box is starting; retry shortly", "BOX_STARTING")
	errBoxStopped     = common_errors.NewCustomError(http.StatusServiceUnavailable, "box is stopped and auto-resume is disabled", "BOX_STOPPED")
	errBoxUnavailable = common_errors.NewCustomError(http.StatusConflict, "box cannot be started", "BOX_UNAVAILABLE")
)

// runnerTunnelError is a non-200 answer to the runner CONNECT.
type runnerTunnelError struct {
	statusCode int
	code       string
}

func (e *runnerTunnelError) Error() string {
	return fmt.Sprintf("runner CONNECT returned %d %s", e.statusCode, e.code)
}

// dialGuestPortWithWake dials a guest port, waking a stopped box on the way.
// A running box's failure is returned as is. box_not_running triggers one
// ensure-ready call, then a wait for the port while the box replays its cmd.
// A request whose dial fails while that wake is in progress (502: the box runs
// but its service does not listen yet) joins the wake instead of failing.
func (p *Proxy) dialGuestPortWithWake(ctx context.Context, boxID string, port uint16) (net.Conn, error) {
	runnerInfo, err := p.getBoxRunnerInfo(ctx, boxID)
	if err != nil {
		return nil, fmt.Errorf("resolve runner for box %s: %w", boxID, err)
	}
	conn, err := dialRunnerTunnel(ctx, runnerInfo, boxID, port)
	if err == nil {
		return conn, nil
	}
	var deadline time.Time
	switch {
	case isBoxNotRunning(err):
		// The wake outlives this request: the shared poll clears the entry
		// when it ends (waitForGuestPort), so a request that hangs up here
		// leaves the wake joinable for the ones still to come. Requests that
		// start it together share its deadline, so that clearing ends it.
		deadline = p.startWake(boxID)
		if err := p.wakeBox(ctx, boxID, deadline); err != nil {
			if ctx.Err() == nil {
				p.wakeDeadlines.CompareAndDelete(boxID, deadline) // the box will not start
			}
			return nil, err
		}
	case p.waking(boxID, &deadline):
	default:
		return nil, err
	}
	if err := p.waitForGuestPort(ctx, runnerInfo, boxID, port, deadline); err != nil {
		return nil, err
	}
	return dialRunnerTunnel(ctx, runnerInfo, boxID, port)
}

// startWake returns the deadline of boxID's wake, starting one when none is
// within its budget.
func (p *Proxy) startWake(boxID string) time.Time {
	deadline := time.Now().Add(guestWakeBudget)
	for {
		current, loaded := p.wakeDeadlines.LoadOrStore(boxID, deadline)
		if !loaded {
			return deadline
		}
		if time.Now().Before(current.(time.Time)) {
			return current.(time.Time)
		}
		p.wakeDeadlines.CompareAndDelete(boxID, current) // expired: start anew
	}
}

// waking reports whether a wake for boxID is still within its budget, and if
// so sets deadline to that budget's end.
func (p *Proxy) waking(boxID string, deadline *time.Time) bool {
	value, ok := p.wakeDeadlines.Load(boxID)
	if !ok {
		return false
	}
	if !time.Now().Before(value.(time.Time)) {
		p.wakeDeadlines.CompareAndDelete(boxID, value) // a wake nobody polled
		return false
	}
	*deadline = value.(time.Time)
	return true
}

func isBoxNotRunning(err error) bool {
	var tunnelErr *runnerTunnelError
	return errors.As(err, &tunnelErr) && tunnelErr.code == runnerBoxNotRunning
}

// waitForGuestPort polls the runner until the guest port accepts a dial.
// Concurrent requests for one port share a poll, so a page that loads many
// assets from a waking box sends one dial per interval, not one per asset.
// The poll closes the connection it gets, and each request dials its own.
func (p *Proxy) waitForGuestPort(ctx context.Context, runnerInfo *RunnerInfo, boxID string, port uint16, deadline time.Time) error {
	key := fmt.Sprintf("%s:%d", boxID, port)
	result := p.guestPortGroup.DoChan(key, func() (any, error) {
		// Detached so one client hanging up does not fail the others.
		pollCtx, cancel := context.WithDeadline(context.WithoutCancel(ctx), deadline)
		defer cancel()
		// The wake ends with this poll, not with any one request waiting on it.
		defer p.wakeDeadlines.CompareAndDelete(boxID, deadline)
		return nil, pollGuestPort(pollCtx, runnerInfo, boxID, port)
	})
	select {
	case <-ctx.Done():
		return ctx.Err()
	case r := <-result:
		return r.Err
	}
}

// pollGuestPort retries the dial while the box is still starting (the runner
// answers box_not_running) or its service does not listen yet (502).
func pollGuestPort(ctx context.Context, runnerInfo *RunnerInfo, boxID string, port uint16) error {
	for {
		conn, err := dialRunnerTunnel(ctx, runnerInfo, boxID, port)
		if err == nil {
			conn.Close()
			return nil
		}
		var tunnelErr *runnerTunnelError
		if !errors.As(err, &tunnelErr) {
			if ctx.Err() != nil {
				return errBoxStarting
			}
			return err
		}
		if tunnelErr.code != runnerBoxNotRunning && tunnelErr.statusCode != http.StatusBadGateway {
			return err
		}
		select {
		case <-ctx.Done():
			return errBoxStarting
		case <-time.After(guestDialRetryInterval):
		}
	}
}

// wakeBox asks the API to start the box. Concurrent requests for one box share
// a call; the API's state-change lock dedupes across proxy replicas. Only an
// answer that retrying cannot change is returned; anything else is logged and
// the caller keeps polling the dial.
func (p *Proxy) wakeBox(ctx context.Context, boxID string, deadline time.Time) error {
	result := p.wakeGroup.DoChan(boxID, func() (any, error) {
		// Detached so one client hanging up does not fail the others.
		wakeCtx, cancel := context.WithDeadline(context.WithoutCancel(ctx), deadline)
		defer cancel()
		return nil, p.requestEnsureReady(wakeCtx, boxID)
	})
	var err error
	select {
	case <-ctx.Done():
		return ctx.Err()
	case r := <-result:
		err = r.Err
	}
	var notFound *common_errors.NotFoundError
	switch {
	case err == nil:
		return nil
	case errors.Is(err, errBoxStopped), errors.Is(err, errBoxUnavailable), errors.As(err, &notFound):
		return err
	case errors.Is(err, context.DeadlineExceeded):
		slog.WarnContext(ctx, "box did not start within the wake budget", "box", boxID)
	default:
		slog.ErrorContext(ctx, "failed to wake box", "box", boxID, "error", err)
	}
	return nil
}

func (p *Proxy) requestEnsureReady(ctx context.Context, boxID string) error {
	configuration := p.apiclient.GetConfig()
	endpoint, err := url.JoinPath(configuration.Servers[0].URL, "preview", boxID, "ensure-ready")
	if err != nil {
		return fmt.Errorf("build ensure-ready endpoint: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, nil)
	if err != nil {
		return fmt.Errorf("build ensure-ready request: %w", err)
	}
	request.Header.Set("Authorization", configuration.DefaultHeader["Authorization"])
	client := configuration.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("ensure-ready for box %s: %w", boxID, err)
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusNoContent, http.StatusOK:
		return nil
	case http.StatusConflict:
		return errBoxStopped
	case http.StatusBadRequest, http.StatusForbidden:
		return errBoxUnavailable
	case http.StatusNotFound:
		return common_errors.NewNotFoundError(fmt.Errorf("box %s not found", boxID))
	default:
		return fmt.Errorf("ensure-ready for box %s: API returned %d", boxID, response.StatusCode)
	}
}

// guestDialFailure turns a dial error into the response the client gets, and
// sets Retry-After on header when retrying the same request can succeed.
func guestDialFailure(header http.Header, err error) *common_errors.CustomError {
	var custom *common_errors.CustomError
	if errors.As(err, &custom) {
		if errors.Is(err, errBoxStarting) {
			header.Set("Retry-After", boxStartingRetryAfter)
		}
		return custom
	}
	var notFound *common_errors.NotFoundError
	if errors.As(err, &notFound) {
		return &common_errors.CustomError{StatusCode: http.StatusNotFound, Message: notFound.Error(), Code: "NOT_FOUND"}
	}
	return &common_errors.CustomError{StatusCode: http.StatusBadGateway, Message: "box unreachable", Code: "BAD_GATEWAY"}
}
