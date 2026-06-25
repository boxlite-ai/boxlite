// ErrSink unifies error propagation out of background goroutines.
//
// The gvproxy-bridge pattern is a recurring trap: `go func() { ... }()`
// starts long-lived work whose only natural failure path is `logrus.Error`.
// The outer cgo `gvproxy_create` returns a valid id before any of that
// goroutine state is observable, so a half-initialized instance ships
// downstream and the failure surfaces 20s later as some unrelated symptom
// (PR #612 fixed this for `virtualnetwork.New`; the four sibling silent
// failures listed below still produced the same class of bug).
//
// The two-channel design:
//
//   - **Init phase** (`initErr`, buffered 1): every error that MUST be
//     surfaced before `gvproxy_create` returns to its cgo caller.
//     Drained exactly once via `WaitInit()`. The caller treats non-nil
//     as fatal: tear down, set the cgo errOut string, return -1.
//
//   - **Runtime phase** (`runtimeErr`, buffered 16): errors that arise
//     after init has succeeded — VM accept failures, protocol handler
//     panics, late TCP filter misconfig. Polled by the Rust runtime via
//     `gvproxy_poll_runtime_error` so the user sees them as a structured
//     `Network` error in the box log instead of a silent gvproxy log line.
//
// Channel sizing rationale:
//   - `initErr` is 1 because there's exactly one init result per instance.
//   - `runtimeErr` is 16 because we cap memory growth — drops are logged
//     but never block the producing goroutine (which is usually in the
//     hot path of packet delivery).
//
// The five silent-failure sites this sink covers (post-wiring):
//   - main.go:454  OverrideTCPHandler          [INIT after move]
//   - main.go:475  transport.AcceptVfkit       [RUNTIME, macOS]
//   - main.go:484  vn.AcceptVfkit              [RUNTIME, macOS]
//   - main.go:496  listener.Accept (Linux)     [RUNTIME]
//   - main.go:510  vn.AcceptQemu               [RUNTIME, Linux]

package main

import (
	"fmt"
	"sync/atomic"
	"time"

	"github.com/sirupsen/logrus"
)

// runtimeErrQueueSize caps the number of unread runtime errors per
// instance. Picked at 16 because:
//   - typical runtime failure cadence is < 1 per minute (Accept errors
//     only fire on VM disconnect / shim crash; protocol errors are rare)
//   - a Rust-side poller runs every ~250ms (well under 16/min)
//   - bounded memory growth is more important than zero-loss; we log
//     the drop so an operator hunting silent-failure regressions can
//     correlate via the `runtime_err_dropped` warning
const runtimeErrQueueSize = 16

// RuntimeError is a single failure event from a post-init goroutine.
// `Source` names the call site (`"AcceptQemu"`, `"OverrideTCPHandler"`,
// …) so the operator can locate the root cause; `When` lets the Rust
// side stamp the event when it polled vs when it occurred.
type RuntimeError struct {
	Source string
	Err    error
	When   time.Time
}

// String renders the error for `gvproxy_poll_runtime_error`'s C string
// return — operator-readable, one line.
func (e RuntimeError) String() string {
	return fmt.Sprintf("[%s] %s: %v", e.When.UTC().Format(time.RFC3339Nano), e.Source, e.Err)
}

// ErrSink is the single error-propagation entry point for every
// background goroutine spawned by `gvproxy_create`. Pre-existing
// `initErr`-style channels and per-site `logrus.Error` calls are
// replaced with calls to `Init()` / `Runtime()` so future code review
// has exactly one symbol to look for ("did you call sink.Init or
// sink.Runtime?") instead of "did you remember to register your own
// channel?".
type ErrSink struct {
	instanceID int64

	initErr    chan error        // buffered 1
	runtimeErr chan RuntimeError // buffered runtimeErrQueueSize

	// dropped counts runtimeErr full-queue drops. Atomic so callers
	// can poll without taking a lock. Exposed via DroppedRuntimeCount()
	// for tests; the production poller logs the warning eagerly.
	dropped int64
}

// NewErrSink builds an empty sink keyed to a gvproxy instance id.
func NewErrSink(instanceID int64) *ErrSink {
	return &ErrSink{
		instanceID: instanceID,
		initErr:    make(chan error, 1),
		runtimeErr: make(chan RuntimeError, runtimeErrQueueSize),
	}
}

// Init records the outcome of a one-shot init-phase operation.
// `source` is the operation name (`"virtualnetwork.New"`, …) so the
// final error string identifies the failing site.
//
// Send is non-blocking only because `initErr` is buffered 1 AND every
// goroutine calls `Init` at most once. A second call would block; the
// design contract is "one Init per goroutine, and there's exactly one
// init goroutine".
//
// nil err = success signal; the caller of `WaitInit()` unblocks with
// nil and proceeds.
func (s *ErrSink) Init(source string, err error) {
	if err != nil {
		s.initErr <- fmt.Errorf("%s: %w", source, err)
		return
	}
	s.initErr <- nil
}

// WaitInit blocks until exactly one `Init()` result lands. Returns
// nil on success or the wrapped error on failure.
//
// Called once by `gvproxy_create` after spawning the init goroutine,
// before returning the instance id to cgo.
func (s *ErrSink) WaitInit() error {
	return <-s.initErr
}

// Runtime records a post-init failure. Never blocks; full queue drops
// the event, increments the `dropped` counter, and logs a one-line
// warning so an operator chasing a regression knows to widen their
// poll interval or drain the queue. Producer-side safety matters more
// than zero-loss for these — the goroutines run on the packet-delivery
// hot path.
//
// nil err is a no-op (lets callers write `sink.Runtime("x", err)`
// without a guard).
func (s *ErrSink) Runtime(source string, err error) {
	if err == nil {
		return
	}
	re := RuntimeError{Source: source, Err: err, When: time.Now()}

	select {
	case s.runtimeErr <- re:
	default:
		atomic.AddInt64(&s.dropped, 1)
		logrus.WithFields(logrus.Fields{
			"id":      s.instanceID,
			"source":  source,
			"error":   err,
			"dropped": atomic.LoadInt64(&s.dropped),
		}).Warn("runtime_err_dropped: ErrSink queue full")
	}
}

// PollRuntime returns the oldest unread runtime error, or nil if
// none. Non-blocking — the Rust-side poller can call it in a tight
// loop until nil, then sleep until next tick.
func (s *ErrSink) PollRuntime() *RuntimeError {
	select {
	case re := <-s.runtimeErr:
		return &re
	default:
		return nil
	}
}

// DroppedRuntimeCount is exposed for tests + ops dashboards. Increments
// every time `Runtime()` saw a full queue.
func (s *ErrSink) DroppedRuntimeCount() int64 {
	return atomic.LoadInt64(&s.dropped)
}
