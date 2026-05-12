package boxlite

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/google/uuid"
)

// Reaping policy defaults (Phase 4.1). Operators override via env vars
// (BOXLITE_RECONNECT_GRACE / BOXLITE_SHUTDOWN_GRACE /
// BOXLITE_MAX_SESSION_LIFETIME); tests use SetReapingForTest.
const (
	defaultReconnectGrace     = 5 * time.Minute
	defaultShutdownGrace      = 30 * time.Second
	defaultMaxSessionLifetime = 24 * time.Hour
	defaultCleanupTick        = 30 * time.Second
)

// ErrSignalUnsupported is returned by an execHandle.Signal implementation
// that cannot deliver arbitrary POSIX signals. Held as a sentinel so the
// reaper can short-circuit straight to Kill (Phase 4.1) instead of stalling
// on each escalation step. The production sdkExec adapter delegates to the
// Go SDK's *Execution.Signal, so this fallback only fires for stub handles
// in tests or for SDK implementations on platforms where signal delivery
// hasn't been implemented.
var ErrSignalUnsupported = errors.New("execution signal not supported by SDK")

var ErrExecNotFound = errors.New("execution not found")
var ErrExecClosed = errors.New("execution is closed")
var ErrExecNotTTY = errors.New("execution is not a TTY")
var ErrExecReaping = errors.New("execution is being reaped")
var ErrBoxMismatch = errors.New("execution does not belong to this box")

// execHandle is the subset of *boxlite.Execution methods ExecManager calls.
// Extracting an interface lets tests substitute a stub without standing up a
// real VM, and forces signal vs kill to be distinct verbs at this seam.
type execHandle interface {
	Signal(ctx context.Context, sig int) error
	Kill(ctx context.Context) error
	ResizeTTY(ctx context.Context, rows, cols int) error
	Close() error
	Wait(ctx context.Context) (int, error)
}

// sdkExec adapts *boxlite.Execution to execHandle. Signal delegates to the
// SDK's per-signal FFI (added in the Phase 2.3 follow-up); a nil inner
// indicates a test stub and falls back to ErrSignalUnsupported so cleanup
// paths still terminate cleanly.
type sdkExec struct{ inner *boxlite.Execution }

func (s sdkExec) Signal(ctx context.Context, sig int) error {
	if s.inner == nil {
		return ErrSignalUnsupported
	}
	return s.inner.Signal(ctx, sig)
}
func (s sdkExec) Kill(ctx context.Context) error { return s.inner.Kill(ctx) }
func (s sdkExec) ResizeTTY(ctx context.Context, rows, cols int) error {
	return s.inner.ResizeTTY(ctx, rows, cols)
}
func (s sdkExec) Close() error                          { return s.inner.Close() }
func (s sdkExec) Wait(ctx context.Context) (int, error) { return s.inner.Wait(ctx) }

type ExecManager struct {
	mu    sync.RWMutex
	execs map[string]*ManagedExec

	// Reaping policy (Phase 4.1). Read on every cleanup tick; written only
	// by NewExecManager (env parsing) or SetReapingForTest. Guarded by
	// reapMu so tests can change values mid-run without racing the ticker.
	reapMu             sync.RWMutex
	reconnectGrace     time.Duration
	shutdownGrace      time.Duration
	maxSessionLifetime time.Duration

	// stop signals cleanupLoop to exit (graceful shutdown / test teardown).
	stopOnce sync.Once
	stop     chan struct{}
}

type ManagedExec struct {
	ID        string
	BoxID     string
	stdinW    io.Writer
	execution execHandle
	Done      chan struct{}
	ExitCode  int
	Err       error
	TTY       bool
	created   time.Time

	// handleMu serializes all operations on `execution` and `stdinW`
	// against the deferred Close in the wait goroutine. Without this,
	// Signal/ResizeTTY/stdin Write can race handle.Close().
	handleMu sync.Mutex
	closed   bool

	// Per-stream capture + fan-out sinks. Passed directly to the Go SDK as
	// ExecutionOptions.Stdout/.Stderr — no io.Pipe involved. Every byte the
	// SDK delivers lands in the bus's bounded backlog AND fans out to live
	// subscribers in a single mutex-guarded operation, so a Subscribe call
	// observes the backlog snapshot AND joins the live set atomically.
	// Pattern source: Docker daemon/logger/loggerutils/logfile.go:86-196.
	stdoutBus *streamBus
	stderrBus *streamBus

	// attachMu guards the attach-session fields below. The /attach
	// handler (Phase 3.1) sets Connected/LastDisconnectAt; the Phase 4
	// reaper reads them and toggles SignaledHUP/SignaledTERM as it
	// escalates an orphaned session.
	// doneAt is stamped the first time the reaper observes Done. Used for
	// retention so long-running execs are not evicted immediately on exit.
	doneAt time.Time

	attachMu         sync.Mutex
	Connected        bool
	LastDisconnectAt time.Time
	SignaledHUP      bool
	SignaledTERM     bool
	ReapingKill      bool
	// Escalating is true while the reaper is delivering a cooperative signal
	// (HUP/TERM). MarkConnected() rejects while set, closing the TOCTOU gap
	// between tryEscalate releasing attachMu and Signal() reaching the process.
	Escalating bool
}

// streamBusBacklogCap is the per-stream bounded-byte backlog size. ~256 KiB
// is enough to retain the tail of a chatty exec across a brief attach gap,
// while keeping per-exec memory bounded. Drop-oldest under overflow.
const streamBusBacklogCap = 256 * 1024

// streamBus is a per-stream (stdout XOR stderr) capture + fan-out sink. It
// implements io.Writer so the Go SDK's ExecutionOptions can pass output
// directly into it without an intermediary io.Pipe.
//
// Atomicity: Write and Subscribe both take `mu`. Subscribe replays the
// current backlog INTO the new subscriber's channel and appends to `subs`
// before releasing `mu`. The next Write therefore fans to the new
// subscriber — zero gap, no chunk lost between snapshot and subscribe.
//
// Pattern source: Docker LogFile (`daemon/logger/loggerutils/logfile.go:86-196`)
// — "snapshot pos + append to wait list inside one critical section".
// Adapted to bytes-in-memory because we don't have a backing log file.
type streamBus struct {
	mu      sync.Mutex
	backlog []byte // bounded ring; drop-oldest on overflow
	cap     int
	subs    []*streamSub
	closed  bool // wait task signalled EOF
}

func newStreamBus(cap int) *streamBus {
	if cap <= 0 {
		cap = streamBusBacklogCap
	}
	return &streamBus{cap: cap}
}

// streamSub is the read side of one subscriber. Bounded channel; on
// overflow the producer drops the chunk and accumulates the byte count in
// `dropped` so /attach can surface a lag warning to the client.
type streamSub struct {
	ch      chan []byte
	dropped atomic.Uint64
}

// Chan returns the receive side of the subscriber's channel. It is closed
// when the subscriber is cancelled OR when the bus closes (EOF).
func (s *streamSub) Chan() <-chan []byte { return s.ch }

// Dropped returns the cumulative bytes dropped due to subscriber back-pressure.
func (s *streamSub) Dropped() uint64 { return s.dropped.Load() }

// Write implements io.Writer. Called by the Go SDK's stdout/stderr pump.
// Appends `p` to the bounded backlog (drop-oldest when full), then
// non-blocking-sends a copy of `p` to every subscriber's channel.
func (b *streamBus) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	chunk := make([]byte, len(p))
	copy(chunk, p)

	b.mu.Lock()
	// Append to backlog; evict oldest bytes when over capacity.
	b.backlog = append(b.backlog, chunk...)
	if len(b.backlog) > b.cap {
		excess := len(b.backlog) - b.cap
		trimmed := make([]byte, b.cap)
		copy(trimmed, b.backlog[excess:])
		b.backlog = trimmed
	}
	// Fan out (non-blocking) to live subscribers.
	for _, sub := range b.subs {
		select {
		case sub.ch <- chunk:
		default:
			sub.dropped.Add(uint64(len(chunk)))
		}
	}
	b.mu.Unlock()
	return len(p), nil
}

// Subscribe registers a new fan-out subscriber. The returned channel
// receives, in order:
//  1. A single snapshot chunk containing the bus's current backlog (if any).
//  2. Live chunks pushed by subsequent Write calls.
//  3. A close (after Cancel or after the bus's close()).
//
// `cancel` MUST be called by every caller (typically in a defer) so the
// subscriber slice doesn't grow unbounded.
func (b *streamBus) Subscribe(chBuf int) (sub *streamSub, cancel func()) {
	if chBuf <= 0 {
		chBuf = 256
	}
	s := &streamSub{ch: make(chan []byte, chBuf)}

	b.mu.Lock()
	if len(b.backlog) > 0 {
		replay := make([]byte, len(b.backlog))
		copy(replay, b.backlog)
		// chBuf is fresh and empty here, so this send is guaranteed
		// non-blocking and cannot drop the replay snapshot.
		s.ch <- replay
	}
	if b.closed {
		// Bus closed before Subscribe — replay-then-EOF, no live add.
		b.mu.Unlock()
		close(s.ch)
		return s, func() {}
	}
	b.subs = append(b.subs, s)
	b.mu.Unlock()

	cancel = func() {
		b.mu.Lock()
		removed := false
		for i, x := range b.subs {
			if x == s {
				b.subs = append(b.subs[:i], b.subs[i+1:]...)
				removed = true
				break
			}
		}
		b.mu.Unlock()
		if removed {
			close(s.ch)
		}
	}
	return s, cancel
}

// close marks the bus closed and signals EOF to every current subscriber by
// closing their channels. Idempotent.
func (b *streamBus) close() {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return
	}
	b.closed = true
	subs := b.subs
	b.subs = nil
	b.mu.Unlock()
	for _, sub := range subs {
		close(sub.ch)
	}
}

func NewExecManager() *ExecManager {
	m := &ExecManager{
		execs:              make(map[string]*ManagedExec),
		reconnectGrace:     resolveDuration("BOXLITE_RECONNECT_GRACE", defaultReconnectGrace),
		shutdownGrace:      resolveDuration("BOXLITE_SHUTDOWN_GRACE", defaultShutdownGrace),
		maxSessionLifetime: resolveDuration("BOXLITE_MAX_SESSION_LIFETIME", defaultMaxSessionLifetime),
		stop:               make(chan struct{}),
	}
	go m.cleanupLoop(defaultCleanupTick)
	return m
}

// resolveDuration reads an env var as a Go duration, falling back to fallback
// if unset, empty, or unparseable. A bad value is logged once at startup so
// operators don't silently inherit the default.
func resolveDuration(envVar string, fallback time.Duration) time.Duration {
	raw := os.Getenv(envVar)
	if raw == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(raw)
	if err != nil {
		slog.Warn("boxlite: invalid duration env var, using default",
			"env", envVar, "value", raw, "default", fallback, "err", err)
		return fallback
	}
	return parsed
}

// SetReapingForTest overrides the reaping policy. Intended for unit tests; do
// not call from production code. Concurrency-safe with cleanupLoop.
func (m *ExecManager) SetReapingForTest(reconnect, shutdown, maxLifetime time.Duration) {
	m.reapMu.Lock()
	defer m.reapMu.Unlock()
	m.reconnectGrace = reconnect
	m.shutdownGrace = shutdown
	m.maxSessionLifetime = maxLifetime
}

func (m *ExecManager) reapingPolicy() (reconnect, shutdown, maxLifetime time.Duration) {
	m.reapMu.RLock()
	defer m.reapMu.RUnlock()
	return m.reconnectGrace, m.shutdownGrace, m.maxSessionLifetime
}

// Stop terminates the cleanupLoop goroutine. Safe to call multiple times.
// Tests use this to disable the live ticker and drive runCleanupOnce
// deterministically.
func (m *ExecManager) Stop() {
	m.stopOnce.Do(func() {
		close(m.stop)
	})
}

// StartOptions captures the per-execution knobs ExecManager.Start
// forwards to the SDK. Grouping them keeps the Start signature stable
// as more fields are added (env, workdir, timeout joined command/args/tty
// in this commit).
type StartOptions struct {
	Command    string
	Args       []string
	Env        map[string]string
	WorkingDir string
	Timeout    time.Duration
	TTY        bool
}

func (m *ExecManager) Start(ctx context.Context, bx *boxlite.Box, boxID string, opts StartOptions) (string, error) {
	id := uuid.New().String()

	now := time.Now()
	exec := &ManagedExec{
		ID:        id,
		BoxID:     boxID,
		stdoutBus: newStreamBus(streamBusBacklogCap),
		stderrBus: newStreamBus(streamBusBacklogCap),
		Done:      make(chan struct{}),
		TTY:       opts.TTY,
		created:   now,
		// Start the reap clock from creation so a client that never
		// calls /attach still escalates through SIGHUP→SIGTERM→SIGKILL
		// at the reconnect_grace boundary. The first successful
		// MarkConnected() zeros LastDisconnectAt, pausing the clock.
		LastDisconnectAt: now,
	}

	// Pass the streamBus sinks directly to the SDK — no io.Pipe between
	// the producer and the fan-out. The SDK's pump calls bus.Write, which
	// captures into the bounded backlog AND fans out to live subscribers
	// in one mutex-guarded operation. Subscribers attached before any
	// Write observe the backlog snapshot on Subscribe.
	execution, err := bx.StartExecution(ctx, opts.Command, opts.Args, &boxlite.ExecutionOptions{
		TTY:        opts.TTY,
		Stdout:     exec.stdoutBus,
		Stderr:     exec.stderrBus,
		Env:        opts.Env,
		WorkingDir: opts.WorkingDir,
		Timeout:    opts.Timeout,
	})
	if err != nil {
		return "", fmt.Errorf("failed to start execution: %w", err)
	}
	handle := sdkExec{inner: execution}
	exec.execution = handle
	exec.stdinW = execution.Stdin

	go func() {
		defer close(exec.Done)
		defer exec.stdoutBus.close()
		defer exec.stderrBus.close()
		defer func() {
			exec.handleMu.Lock()
			handle.Close()
			exec.closed = true
			exec.handleMu.Unlock()
		}()

		exitCode, err := handle.Wait(context.Background())
		exec.ExitCode = exitCode
		exec.Err = err
	}()

	m.mu.Lock()
	m.execs[id] = exec
	m.mu.Unlock()

	return id, nil
}

// Subscribe registers a fan-out subscriber on both the stdout and stderr
// buses. Returns the read sides + a single cancel function that
// unregisters both. Equivalent in shape to the prior execSubscriber API so
// the /attach adapter doesn't have to change. Always pair with cancel
// (typically in a defer).
func (e *ManagedExec) Subscribe(bufSize int) (stdout, stderr *streamSub, cancel func()) {
	out, outCancel := e.stdoutBus.Subscribe(bufSize)
	err, errCancel := e.stderrBus.Subscribe(bufSize)
	return out, err, func() {
		outCancel()
		errCancel()
	}
}

func (m *ExecManager) Get(id string) (*ManagedExec, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	e, ok := m.execs[id]
	return e, ok
}

func (m *ExecManager) GetForBox(id, boxID string) (*ManagedExec, error) {
	m.mu.RLock()
	e, ok := m.execs[id]
	m.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrExecNotFound, id)
	}
	if e.BoxID != boxID {
		return nil, fmt.Errorf("%w: %s", ErrBoxMismatch, id)
	}
	return e, nil
}

func (m *ExecManager) Signal(id string, sig int) error {
	m.mu.RLock()
	e, ok := m.execs[id]
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("%w: %s", ErrExecNotFound, id)
	}
	e.attachMu.Lock()
	reaping := e.ReapingKill || e.Escalating
	e.attachMu.Unlock()
	if reaping {
		return fmt.Errorf("%w: %s", ErrExecReaping, id)
	}
	e.handleMu.Lock()
	defer e.handleMu.Unlock()
	if e.closed || e.execution == nil {
		return fmt.Errorf("%w: %s", ErrExecClosed, id)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return e.execution.Signal(ctx, sig)
}

// Kill terminates the execution with SIGKILL and evicts it from the
// registry. Closes the stdout/stderr reader pipes so any pending readers
// unblock.
func (m *ExecManager) Kill(id string) error {
	m.mu.RLock()
	e, ok := m.execs[id]
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("%w: %s", ErrExecNotFound, id)
	}

	e.attachMu.Lock()
	e.ReapingKill = true
	e.attachMu.Unlock()

	e.handleMu.Lock()
	if !e.closed && e.execution != nil {
		killCtx, killCancel := context.WithTimeout(context.Background(), 10*time.Second)
		err := e.execution.Kill(killCtx)
		killCancel()
		e.handleMu.Unlock()
		if err != nil {
			return err
		}
	} else {
		e.handleMu.Unlock()
	}

	m.mu.Lock()
	delete(m.execs, id)
	m.mu.Unlock()

	if e.stdoutBus != nil {
		e.stdoutBus.close()
	}
	if e.stderrBus != nil {
		e.stderrBus.close()
	}
	return nil
}

// Register inserts a ManagedExec under the given id. Intended for tests
// that need to seed the registry without spinning up a real VM; callers
// should use Start in production.
func (m *ExecManager) Register(id string, e *ManagedExec) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e.created.IsZero() {
		e.created = time.Now()
	}
	if e.ID == "" {
		e.ID = id
	}
	m.execs[id] = e
}

// ExecHandle is the public alias of execHandle used by test code in other
// packages (e.g. the controllers test) to inject a stub execution into a
// ManagedExec.
type ExecHandle = execHandle

// SetExecHandle wires a test-provided execHandle into a ManagedExec.
// Production code constructs ManagedExec via ExecManager.Start which sets
// this internally; this helper exists so cross-package tests can drive
// Signal/Kill paths without spinning up a real SDK execution.
func (e *ManagedExec) SetExecHandle(h ExecHandle) {
	e.execution = h
}

func (m *ExecManager) ResizeTTY(id string, rows, cols int) error {
	m.mu.RLock()
	e, ok := m.execs[id]
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("%w: %s", ErrExecNotFound, id)
	}
	e.attachMu.Lock()
	reaping := e.ReapingKill || e.Escalating
	e.attachMu.Unlock()
	if reaping {
		return fmt.Errorf("%w: %s", ErrExecReaping, id)
	}
	e.handleMu.Lock()
	defer e.handleMu.Unlock()
	if e.closed || e.execution == nil {
		return fmt.Errorf("%w: %s", ErrExecClosed, id)
	}
	if !e.TTY {
		return fmt.Errorf("%w: %s", ErrExecNotTTY, id)
	}
	resizeCtx, resizeCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer resizeCancel()
	return e.execution.ResizeTTY(resizeCtx, rows, cols)
}

func (m *ExecManager) cleanupLoop(tick time.Duration) {
	ticker := time.NewTicker(tick)
	defer ticker.Stop()
	for {
		select {
		case <-m.stop:
			return
		case <-ticker.C:
			m.runCleanupOnce(time.Now())
		}
	}
}

// runCleanupOnce applies the reap policy to every tracked exec. Split out
// from cleanupLoop so tests can drive a single tick deterministically
// without fighting time.NewTicker.
func (m *ExecManager) runCleanupOnce(now time.Time) {
	reconnectGrace, shutdownGrace, maxLifetime := m.reapingPolicy()

	m.mu.RLock()
	candidates := make([]*ManagedExec, 0, len(m.execs))
	for _, e := range m.execs {
		candidates = append(candidates, e)
	}
	m.mu.RUnlock()

	for _, e := range candidates {
		m.evaluateExec(now, e, reconnectGrace, shutdownGrace, maxLifetime)
	}
}

func (m *ExecManager) evaluateExec(now time.Time, e *ManagedExec, reconnectGrace, shutdownGrace, maxLifetime time.Duration) {
	// 1) Done check first — a completed exec is always handled by the
	// retention path, even if it exceeds the lifetime cap. This avoids
	// starving done-eviction when killAndEvict keeps failing.
	select {
	case <-e.Done:
		if e.doneAt.IsZero() {
			e.doneAt = now
		}
		if now.Sub(e.doneAt) > 5*time.Minute {
			m.evictExited(e)
		}
		return
	default:
	}

	// 2) Hard cap — kill regardless of attach state.
	if now.Sub(e.created) > maxLifetime {
		e.attachMu.Lock()
		e.ReapingKill = true
		e.attachMu.Unlock()
		slog.Warn("boxlite: session lifetime cap reached, killing exec",
			"exec_id", e.ID, "age", now.Sub(e.created))
		m.killAndEvict(e)
		return
	}

	// 2b) Retry kill for entries marked doomed by a prior tick or a
	// failed DELETE handler.
	e.attachMu.Lock()
	pendingKill := e.ReapingKill
	e.attachMu.Unlock()
	if pendingKill {
		m.killAndEvict(e)
		return
	}

	// 3) Orphan escalation.
	action := e.tryEscalate(now, reconnectGrace, shutdownGrace)
	switch action {
	case escalateNone:
		return
	case escalateHUP:
		m.escalate(e, syscall.SIGHUP, "SIGHUP")
		e.FinishEscalation()
	case escalateTERM:
		m.escalate(e, syscall.SIGTERM, "SIGTERM")
		e.FinishEscalation()
	case escalateKILL:
		slog.Warn("boxlite: orphan exec did not exit after SIGTERM, killing",
			"exec_id", e.ID)
		m.killAndEvict(e)
	}
}

type escalateAction int

const (
	escalateNone escalateAction = iota
	escalateHUP
	escalateTERM
	escalateKILL
)

// tryEscalate atomically determines the next reaper action under attachMu.
func (e *ManagedExec) tryEscalate(now time.Time, reconnectGrace, shutdownGrace time.Duration) escalateAction {
	e.attachMu.Lock()
	defer e.attachMu.Unlock()

	if e.Connected || e.ReapingKill || e.Escalating {
		return escalateNone
	}
	if e.LastDisconnectAt.IsZero() {
		return escalateNone
	}
	idleFor := now.Sub(e.LastDisconnectAt)

	switch {
	case !e.SignaledHUP:
		if idleFor <= reconnectGrace {
			return escalateNone
		}
		e.SignaledHUP = true
		e.Escalating = true
		e.LastDisconnectAt = now
		return escalateHUP
	case !e.SignaledTERM:
		if idleFor <= shutdownGrace {
			return escalateNone
		}
		e.SignaledTERM = true
		e.Escalating = true
		e.LastDisconnectAt = now
		return escalateTERM
	default:
		if idleFor <= shutdownGrace {
			return escalateNone
		}
		e.ReapingKill = true
		return escalateKILL
	}
}

// escalate sends sig via the exec handle. ErrSignalUnsupported short-
// circuits to Kill so the orphan still gets reaped instead of stalling.
// State transitions (SignaledHUP/TERM) have already been applied atomically
// in tryEscalate under attachMu.
func (m *ExecManager) escalate(e *ManagedExec, sig syscall.Signal, name string) {
	slog.Info("boxlite: orphan exec escalation",
		"exec_id", e.ID, "signal", name)

	e.handleMu.Lock()
	if e.closed || e.execution == nil {
		e.handleMu.Unlock()
		e.escalationFailedMarkDoomed()
		m.killAndEvict(e)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	err := e.execution.Signal(ctx, int(sig))
	e.handleMu.Unlock()
	cancel()
	switch {
	case err == nil:
		// State already updated in tryEscalate.
	case errors.Is(err, ErrSignalUnsupported):
		slog.Warn("boxlite: SDK cannot deliver signal, falling through to Kill",
			"exec_id", e.ID, "signal", name)
		e.escalationFailedMarkDoomed()
		m.killAndEvict(e)
	default:
		slog.Warn("boxlite: signal delivery failed, killing exec",
			"exec_id", e.ID, "signal", name, "err", err)
		e.escalationFailedMarkDoomed()
		m.killAndEvict(e)
	}
}

// killAndEvict mirrors the Kill() public method but operates on an
// already-resolved ManagedExec pointer (cleanup paths already snapshotted
// the map). The map delete is idempotent.
func (m *ExecManager) killAndEvict(e *ManagedExec) {
	m.mu.RLock()
	_, stillTracked := m.execs[e.ID]
	m.mu.RUnlock()
	if !stillTracked {
		return
	}

	e.handleMu.Lock()
	if !e.closed && e.execution != nil {
		killCtx, killCancel := context.WithTimeout(context.Background(), 10*time.Second)
		err := e.execution.Kill(killCtx)
		killCancel()
		e.handleMu.Unlock()
		if err != nil {
			slog.Warn("boxlite: kill failed during reap, will retry next tick",
				"exec_id", e.ID, "err", err)
			return
		}
	} else {
		e.handleMu.Unlock()
	}

	m.mu.Lock()
	delete(m.execs, e.ID)
	m.mu.Unlock()

	if e.stdoutBus != nil {
		e.stdoutBus.close()
	}
	if e.stderrBus != nil {
		e.stderrBus.close()
	}
}

// evictExited removes a Done exec from the map and signals EOF to any
// remaining subscribers. No kill — the underlying process already exited.
func (m *ExecManager) evictExited(e *ManagedExec) {
	e.attachMu.Lock()
	e.ReapingKill = true
	e.attachMu.Unlock()

	m.mu.Lock()
	if _, stillTracked := m.execs[e.ID]; !stillTracked {
		m.mu.Unlock()
		return
	}
	delete(m.execs, e.ID)
	m.mu.Unlock()

	if e.stdoutBus != nil {
		e.stdoutBus.close()
	}
	if e.stderrBus != nil {
		e.stderrBus.close()
	}
}

// --- Attach helpers (Phase 3.1) ---
//
// These methods are additive — they expose the slice of ManagedExec the
// /attach WebSocket handler needs without touching the existing SSE/POST
// helpers above.

// MarkConnected claims the single-attach slot. Returns false if another
// client is already attached OR the reaper has claimed a terminal kill.
// A successful claim resets the escalation flags so a subsequent
// disconnect starts a fresh reap clock.
func (e *ManagedExec) MarkConnected() bool {
	e.attachMu.Lock()
	defer e.attachMu.Unlock()
	if e.Connected || e.ReapingKill || e.Escalating {
		return false
	}
	e.Connected = true
	e.LastDisconnectAt = time.Time{}
	e.SignaledHUP = false
	e.SignaledTERM = false
	return true
}

// FinishEscalation clears the Escalating flag after signal delivery so
// MarkConnected() can succeed again. Called by the reaper after escalate().
func (e *ManagedExec) FinishEscalation() {
	e.attachMu.Lock()
	defer e.attachMu.Unlock()
	e.Escalating = false
}

// escalationFailedMarkDoomed atomically sets ReapingKill and clears
// Escalating so no gap exists for MarkConnected to slip through.
func (e *ManagedExec) escalationFailedMarkDoomed() {
	e.attachMu.Lock()
	defer e.attachMu.Unlock()
	e.ReapingKill = true
	e.Escalating = false
}

// MarkDisconnected releases the single-attach slot and stamps
// LastDisconnectAt for the Phase 4 reaper.
func (e *ManagedExec) MarkDisconnected() {
	e.attachMu.Lock()
	defer e.attachMu.Unlock()
	e.Connected = false
	e.LastDisconnectAt = time.Now()
}

// AttachWriteStdin writes stdin bytes under handleMu so it cannot race
// the wait goroutine's handle.Close().
func (e *ManagedExec) AttachWriteStdin(data []byte) (int, error) {
	e.handleMu.Lock()
	defer e.handleMu.Unlock()
	if e.closed || e.stdinW == nil {
		return 0, fmt.Errorf("execution %s stdin is closed", e.ID)
	}
	return e.stdinW.Write(data)
}

// StdinWriter returns the raw stdin writer. Use AttachWriteStdin for
// locked access from the attach handler.
func (e *ManagedExec) StdinWriter() io.Writer {
	return e.stdinW
}

// AttachCloseStdin signals EOF to the guest process by closing the SDK's
// stdin handle under handleMu.
func (e *ManagedExec) AttachCloseStdin() error {
	e.handleMu.Lock()
	defer e.handleMu.Unlock()
	if e.stdinW == nil {
		return fmt.Errorf("execution %s has no stdin", e.ID)
	}
	closer, ok := e.stdinW.(io.Closer)
	if !ok {
		return nil
	}
	return closer.Close()
}

// AttachResize forwards a TTY size change. The /attach handler routes
// resize control frames here.
func (e *ManagedExec) AttachResize(rows, cols int) error {
	e.handleMu.Lock()
	defer e.handleMu.Unlock()
	if e.closed || e.execution == nil {
		return fmt.Errorf("execution %s is closed", e.ID)
	}
	if !e.TTY {
		return fmt.Errorf("execution %s is not a TTY", e.ID)
	}
	resizeCtx, resizeCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer resizeCancel()
	return e.execution.ResizeTTY(resizeCtx, rows, cols)
}

// AttachSignal forwards an in-band signal to the underlying execution.
// The whitelist that gates which signals reach this method lives at the
// /attach handler boundary (Phase 2.3 owns the same whitelist for the
// REST signal endpoint).
func (e *ManagedExec) AttachSignal(sig int) error {
	e.handleMu.Lock()
	defer e.handleMu.Unlock()
	if e.closed || e.execution == nil {
		return fmt.Errorf("execution %s is closed", e.ID)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return e.execution.Signal(ctx, sig)
}
