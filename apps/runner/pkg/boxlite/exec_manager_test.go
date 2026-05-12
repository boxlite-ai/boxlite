// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

package boxlite

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// stubExecHandle records every Signal/Kill call. Optional override hooks
// let a test simulate ErrSignalUnsupported (or any other error) without
// standing up a real boxlite.Execution. Implements the package-private
// execHandle interface, so additional methods (ResizeTTY/Close/Wait) are
// required even when individual tests don't use them.
type stubExecHandle struct {
	mu       sync.Mutex
	signals  []int
	killed   int
	signalFn func(int) error
	killFn   func() error
}

func (s *stubExecHandle) Signal(_ context.Context, sig int) error {
	s.mu.Lock()
	s.signals = append(s.signals, sig)
	fn := s.signalFn
	s.mu.Unlock()
	if fn != nil {
		return fn(sig)
	}
	return nil
}

func (s *stubExecHandle) Kill(_ context.Context) error {
	s.mu.Lock()
	s.killed++
	fn := s.killFn
	s.mu.Unlock()
	if fn != nil {
		return fn()
	}
	return nil
}

func (s *stubExecHandle) ResizeTTY(_ context.Context, _, _ int) error { return nil }
func (s *stubExecHandle) Close() error                                { return nil }
func (s *stubExecHandle) Wait(_ context.Context) (int, error)         { return 0, nil }

func (s *stubExecHandle) snapshot() (signals []int, killed int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := make([]int, len(s.signals))
	copy(cp, s.signals)
	return cp, s.killed
}

// registerStub builds a ManagedExec wired to the stub and inserts it into
// the manager's map. Done is left open so the orphan-escalation path is
// exercised by default.
func registerStub(t *testing.T, m *ExecManager, id string, stub *stubExecHandle) *ManagedExec {
	t.Helper()
	now := time.Now()
	exec := &ManagedExec{
		ID:        id,
		stdoutBus: newStreamBus(streamBusBacklogCap),
		stderrBus: newStreamBus(streamBusBacklogCap),
		Done:      make(chan struct{}),
		execution: stub,
		created:   now,
		// Mirror Start(): LastDisconnectAt = created so a never-attached
		// exec still escalates through reconnect_grace.
		LastDisconnectAt: now,
	}
	m.mu.Lock()
	m.execs[id] = exec
	m.mu.Unlock()
	return exec
}

// newQuietManager builds an ExecManager whose background cleanupLoop is
// stopped immediately. Tests drive runCleanupOnce explicitly so they don't
// race the live ticker.
func newQuietManager(t *testing.T) *ExecManager {
	t.Helper()
	m := NewExecManager()
	m.Stop()
	return m
}

func TestCleanupLoopEscalatesOnOrphanedExec(t *testing.T) {
	m := newQuietManager(t)

	stub := &stubExecHandle{}
	exec := registerStub(t, m, "orphan-1", stub)

	m.SetReapingForTest(50*time.Millisecond, 20*time.Millisecond, 10*time.Minute)

	t0 := time.Now()
	exec.attachMu.Lock()
	exec.Connected = false
	exec.LastDisconnectAt = t0
	exec.attachMu.Unlock()

	// Pre-grace tick: nothing happens.
	m.runCleanupOnce(t0.Add(30 * time.Millisecond))
	if signals, killed := stub.snapshot(); len(signals) != 0 || killed != 0 {
		t.Fatalf("pre-grace tick should not signal: signals=%v killed=%d", signals, killed)
	}

	// Past reconnect grace: SIGHUP.
	m.runCleanupOnce(t0.Add(70 * time.Millisecond))
	signals, killed := stub.snapshot()
	if killed != 0 {
		t.Fatalf("expected no kill yet, got killed=%d", killed)
	}
	if len(signals) != 1 || signals[0] != int(syscall.SIGHUP) {
		t.Fatalf("expected exactly one SIGHUP, got %v", signals)
	}
	exec.attachMu.Lock()
	if !exec.SignaledHUP {
		exec.attachMu.Unlock()
		t.Fatalf("SignaledHUP not flipped after SIGHUP")
	}
	hupAt := exec.LastDisconnectAt
	exec.attachMu.Unlock()

	// Past shutdown grace after HUP: SIGTERM.
	m.runCleanupOnce(hupAt.Add(25 * time.Millisecond))
	signals, killed = stub.snapshot()
	if killed != 0 {
		t.Fatalf("expected no kill yet after SIGTERM stage, got killed=%d", killed)
	}
	if len(signals) != 2 || signals[1] != int(syscall.SIGTERM) {
		t.Fatalf("expected SIGTERM as second signal, got %v", signals)
	}
	exec.attachMu.Lock()
	if !exec.SignaledTERM {
		exec.attachMu.Unlock()
		t.Fatalf("SignaledTERM not flipped after SIGTERM")
	}
	termAt := exec.LastDisconnectAt
	exec.attachMu.Unlock()

	// Past shutdown grace after TERM: SIGKILL + evict.
	m.runCleanupOnce(termAt.Add(25 * time.Millisecond))
	signals, killed = stub.snapshot()
	if killed != 1 {
		t.Fatalf("expected exactly one Kill, got killed=%d", killed)
	}
	if len(signals) != 2 {
		t.Fatalf("expected no extra Signal calls after kill, got %v", signals)
	}
	if _, stillTracked := m.Get("orphan-1"); stillTracked {
		t.Fatalf("exec should be evicted after SIGKILL")
	}
}

func TestCleanupLoopRespectsHardCap(t *testing.T) {
	m := newQuietManager(t)

	stub := &stubExecHandle{}
	exec := registerStub(t, m, "elder-1", stub)

	m.SetReapingForTest(5*time.Minute, 30*time.Second, 24*time.Hour)

	exec.attachMu.Lock()
	exec.Connected = true
	exec.attachMu.Unlock()
	exec.created = time.Now().Add(-25 * time.Hour)

	m.runCleanupOnce(time.Now())

	signals, killed := stub.snapshot()
	if killed != 1 {
		t.Fatalf("hard cap should kill regardless of Connected: killed=%d", killed)
	}
	if len(signals) != 0 {
		t.Fatalf("hard cap should not deliver intermediate signals, got %v", signals)
	}
	if _, stillTracked := m.Get("elder-1"); stillTracked {
		t.Fatalf("exec should be evicted after hard cap")
	}
}

func TestReattachResetsEscalationFlags(t *testing.T) {
	m := newQuietManager(t)

	stub := &stubExecHandle{}
	exec := registerStub(t, m, "reattach-1", stub)

	m.SetReapingForTest(50*time.Millisecond, 20*time.Millisecond, 10*time.Minute)

	t0 := time.Now()
	exec.attachMu.Lock()
	exec.Connected = false
	exec.LastDisconnectAt = t0
	exec.attachMu.Unlock()

	m.runCleanupOnce(t0.Add(70 * time.Millisecond))
	exec.attachMu.Lock()
	if !exec.SignaledHUP {
		exec.attachMu.Unlock()
		t.Fatalf("expected SIGHUP fired before reattach")
	}
	exec.attachMu.Unlock()

	if !exec.MarkConnected() {
		t.Fatalf("MarkConnected: expected to claim attach slot, got false")
	}

	exec.attachMu.Lock()
	connected, hup, term, lastDisc := exec.Connected, exec.SignaledHUP, exec.SignaledTERM, exec.LastDisconnectAt
	exec.attachMu.Unlock()
	if !connected {
		t.Fatalf("Connected should be true after reattach")
	}
	if hup || term {
		t.Fatalf("escalation flags must reset on reattach: hup=%v term=%v", hup, term)
	}
	if !lastDisc.IsZero() {
		t.Fatalf("LastDisconnectAt should be zeroed on reattach, got %v", lastDisc)
	}

	t1 := time.Now()
	exec.MarkDisconnected()

	preSignals, _ := stub.snapshot()
	prevCount := len(preSignals)

	m.runCleanupOnce(t1.Add(70 * time.Millisecond))
	postSignals, _ := stub.snapshot()
	if len(postSignals) != prevCount+1 {
		t.Fatalf("expected one new signal post-reattach-disconnect, got %d new",
			len(postSignals)-prevCount)
	}
	if postSignals[len(postSignals)-1] != int(syscall.SIGHUP) {
		t.Fatalf("expected fresh SIGHUP cycle, got %v", postSignals[len(postSignals)-1])
	}
}

// trackedStdin counts Close() calls and lets a test inject a Close error.
// Implements io.WriteCloser so the AttachCloseStdin type assertion succeeds.
type trackedStdin struct {
	mu      sync.Mutex
	closed  int
	closeFn func() error
}

func (t *trackedStdin) Write(p []byte) (int, error) { return len(p), nil }
func (t *trackedStdin) Close() error {
	t.mu.Lock()
	t.closed++
	fn := t.closeFn
	t.mu.Unlock()
	if fn != nil {
		return fn()
	}
	return nil
}
func (t *trackedStdin) closeCount() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.closed
}

// writerOnly intentionally does NOT implement io.Closer — covers the
// defensive fallback in AttachCloseStdin.
type writerOnly struct{}

func (writerOnly) Write(p []byte) (int, error) { return len(p), nil }

// TestAttachCloseStdinClosesWriteCloser proves the runner's io.Closer type
// assertion succeeds because the Go SDK's executionStdin implements Close().
// Before the fix, the production stdin handle was Write-only and the close
// branch silently returned nil — clients that sent `{"type":"stdin_eof"}`
// got a success response but the process never saw EOF.
func TestAttachCloseStdinClosesWriteCloser(t *testing.T) {
	m := newQuietManager(t)
	exec := registerStub(t, m, "close-stdin-1", &stubExecHandle{})

	stdin := &trackedStdin{}
	exec.stdinW = stdin

	if err := exec.AttachCloseStdin(); err != nil {
		t.Fatalf("AttachCloseStdin returned error: %v", err)
	}
	if got := stdin.closeCount(); got != 1 {
		t.Fatalf("expected exactly one Close call, got %d", got)
	}

	// Idempotency: a second call also propagates to Close. The SDK's
	// underlying C-FFI is idempotent on its end (Option<ExecStdin>::take
	// already None), so this is safe.
	if err := exec.AttachCloseStdin(); err != nil {
		t.Fatalf("second AttachCloseStdin returned error: %v", err)
	}
	if got := stdin.closeCount(); got != 2 {
		t.Fatalf("expected two Close calls after second invocation, got %d", got)
	}
}

// TestAttachCloseStdinFallsBackForWriterOnly covers the defensive branch:
// if stdin is a plain io.Writer (e.g. an alternate SDK or test stub), the
// close is a no-op rather than a hard error.
func TestAttachCloseStdinFallsBackForWriterOnly(t *testing.T) {
	m := newQuietManager(t)
	exec := registerStub(t, m, "close-stdin-2", &stubExecHandle{})
	exec.stdinW = writerOnly{}

	if err := exec.AttachCloseStdin(); err != nil {
		t.Fatalf("AttachCloseStdin should be a no-op for writer-only stdin, got %v", err)
	}
}

func TestAttachCloseStdinPropagatesCloseError(t *testing.T) {
	m := newQuietManager(t)
	exec := registerStub(t, m, "close-stdin-3", &stubExecHandle{})

	wantErr := errors.New("boom")
	exec.stdinW = &trackedStdin{closeFn: func() error { return wantErr }}

	if err := exec.AttachCloseStdin(); !errors.Is(err, wantErr) {
		t.Fatalf("expected wrapped err %v, got %v", wantErr, err)
	}
}

// TestStreamBusFansOutToMultipleSubscribers proves every Write reaches
// every current subscriber. The streamBus is the sole io.Writer for the
// stream; subscribers come and go without ever competing for a pipe.
func TestStreamBusFansOutToMultipleSubscribers(t *testing.T) {
	bus := newStreamBus(64 * 1024)

	subA, cancelA := bus.Subscribe(8)
	defer cancelA()
	subB, cancelB := bus.Subscribe(8)
	defer cancelB()

	_, _ = bus.Write([]byte("hello"))

	for label, sub := range map[string]*streamSub{"A": subA, "B": subB} {
		select {
		case chunk, ok := <-sub.Chan():
			if !ok {
				t.Fatalf("sub%s: channel closed before any data", label)
			}
			if string(chunk) != "hello" {
				t.Fatalf("sub%s: got %q, want hello", label, chunk)
			}
		case <-time.After(time.Second):
			t.Fatalf("sub%s: timed out waiting for fan-out chunk", label)
		}
	}
}

// TestStreamBusReplaysBacklogToLateSubscriber locks in the round-2 Fix A
// guarantee: bytes written BEFORE Subscribe are preserved in the bounded
// backlog and replayed on Subscribe. This is the bug that was reproduced
// by the old "broadcaster drops pre-subscribe output" test.
func TestStreamBusReplaysBacklogToLateSubscriber(t *testing.T) {
	bus := newStreamBus(64 * 1024)

	_, _ = bus.Write([]byte("early"))
	bus.close() // simulate process exit before any subscriber.

	sub, cancel := bus.Subscribe(8)
	defer cancel()

	// First message must be the replay; channel must then close (EOF).
	select {
	case chunk, ok := <-sub.Chan():
		if !ok {
			t.Fatalf("expected replay chunk before EOF; got immediate close")
		}
		if string(chunk) != "early" {
			t.Fatalf("replay chunk: got %q, want early", chunk)
		}
	case <-time.After(time.Second):
		t.Fatalf("subscriber timed out waiting for backlog replay")
	}
	// After the replay, the channel must close because the bus is closed.
	select {
	case _, ok := <-sub.Chan():
		if ok {
			t.Fatalf("expected EOF after replay; got another chunk")
		}
	case <-time.After(time.Second):
		t.Fatalf("subscriber timed out waiting for EOF after replay")
	}
}

// TestStreamBusReattachReceivesBacklogAndLive proves the canonical /attach
// reattach flow: a subscriber that joins mid-stream sees the existing
// backlog AND every subsequent Write. No bytes lost across the attach gap.
func TestStreamBusReattachReceivesBacklogAndLive(t *testing.T) {
	bus := newStreamBus(64 * 1024)

	// First /attach.
	subA, cancelA := bus.Subscribe(8)
	_, _ = bus.Write([]byte("pre"))
	select {
	case chunk := <-subA.Chan():
		if string(chunk) != "pre" {
			t.Fatalf("subA: got %q want pre", chunk)
		}
	case <-time.After(time.Second):
		t.Fatalf("subA timed out")
	}
	cancelA()

	// Detached. Process continues to emit output.
	_, _ = bus.Write([]byte("during"))

	// Reattach. Must observe both the during-gap byte (via backlog) and
	// any subsequent live writes.
	subB, cancelB := bus.Subscribe(8)
	defer cancelB()

	// Drain backlog replay.
	select {
	case chunk := <-subB.Chan():
		if !strings.Contains(string(chunk), "during") {
			t.Fatalf("subB backlog replay: %q must contain 'during'", chunk)
		}
		// Backlog accumulates: replay may include "pre" + "during" depending
		// on if the first cancel cleared it. Either way 'during' must appear.
	case <-time.After(time.Second):
		t.Fatalf("subB backlog replay timed out — output lost across reattach")
	}

	_, _ = bus.Write([]byte("post"))
	select {
	case chunk := <-subB.Chan():
		if string(chunk) != "post" {
			t.Fatalf("subB live: got %q want post", chunk)
		}
	case <-time.After(time.Second):
		t.Fatalf("subB live timed out")
	}
}

// TestStreamBusRingBufferDropsOldestOnOverflow proves the bounded backlog
// drops the oldest bytes when the cap is exceeded, matching tmux scrollback
// and Docker ringLogger semantics. The tail must be intact.
func TestStreamBusRingBufferDropsOldestOnOverflow(t *testing.T) {
	const cap = 256
	bus := newStreamBus(cap)

	// Write 300 bytes total: "AAAA...A" (100) + "BBBB...B" (100) + "CCCC...C" (100).
	for _, b := range []byte{'A', 'B', 'C'} {
		_, _ = bus.Write(bytes.Repeat([]byte{b}, 100))
	}
	bus.close()

	sub, cancel := bus.Subscribe(8)
	defer cancel()

	chunk, ok := <-sub.Chan()
	if !ok {
		t.Fatalf("expected replay chunk")
	}
	if len(chunk) != cap {
		t.Fatalf("replay length = %d, want %d (the cap)", len(chunk), cap)
	}
	// Head (oldest 'A's) must be dropped; tail (newest 'C's) must be intact.
	// Specifically the last 100 bytes are 'C's.
	for i := len(chunk) - 100; i < len(chunk); i++ {
		if chunk[i] != 'C' {
			t.Fatalf("expected 'C' at idx %d in tail, got %q", i, chunk[i])
		}
	}
	// And the leading 'A's are gone (write 300 total, kept 256 = lost 44 'A's;
	// remaining 56 'A's + 100 'B's + 100 'C's).
	if chunk[0] != 'A' || chunk[55] != 'A' {
		t.Fatalf("expected 'A' at idx 0 and 55, got chunk[0]=%q chunk[55]=%q", chunk[0], chunk[55])
	}
	if chunk[56] != 'B' {
		t.Fatalf("expected 'B' at idx 56 (after 56 retained As), got %q", chunk[56])
	}
}

// TestStreamBusSubscribeIsAtomicWithConcurrentWrite asserts the
// snapshot-and-subscribe critical section is held atomically. Run with
// `-race` — any read/write conflict on the backlog or subscriber slice
// would be flagged. We also assert that every chunk observed by the new
// subscriber's channel is one we actually wrote (no truncation, no extra
// bytes).
func TestStreamBusSubscribeIsAtomicWithConcurrentWrite(t *testing.T) {
	bus := newStreamBus(64 * 1024)
	const writes = 200
	stop := make(chan struct{})

	// Background writer hammering Write.
	go func() {
		for i := 0; i < writes; i++ {
			_, _ = bus.Write([]byte{byte('a' + i%26)})
		}
		close(stop)
	}()

	// Mid-stream subscribe.
	time.Sleep(time.Millisecond)
	sub, cancel := bus.Subscribe(writes + 2)
	defer cancel()

	<-stop
	bus.close()

	// Drain the subscriber. Every chunk must be exactly one byte in the
	// expected alphabet (or a multi-byte backlog replay of same).
	var totalBytes int
	for chunk := range sub.Chan() {
		for _, b := range chunk {
			if b < 'a' || b > 'z' {
				t.Fatalf("observed byte %q not in 'a'..'z' — backlog corruption", b)
			}
		}
		totalBytes += len(chunk)
	}
	if totalBytes == 0 {
		t.Fatalf("subscriber observed zero bytes; race likely")
	}
}

// TestCleanupLoopReapsNeverAttachedExec proves the never-attached reap
// behavior: an exec whose client crashes between POST /exec and /attach
// must still escalate through reconnect_grace → shutdown_grace, not wait
// the full 24h hard cap. Before the fix, evaluateExec bailed early when
// LastDisconnectAt.IsZero(), leaving never-attached execs running.
func TestCleanupLoopReapsNeverAttachedExec(t *testing.T) {
	m := newQuietManager(t)

	stub := &stubExecHandle{}
	// registerStub mirrors production Start(): LastDisconnectAt = created.
	exec := registerStub(t, m, "never-attached-1", stub)

	m.SetReapingForTest(50*time.Millisecond, 20*time.Millisecond, 10*time.Minute)

	// Pre-grace: no signal yet.
	m.runCleanupOnce(exec.created.Add(30 * time.Millisecond))
	if signals, killed := stub.snapshot(); len(signals) != 0 || killed != 0 {
		t.Fatalf("pre-grace tick should not signal never-attached exec: signals=%v killed=%d",
			signals, killed)
	}

	// Past reconnect grace: SIGHUP fires for never-attached exec too.
	m.runCleanupOnce(exec.created.Add(70 * time.Millisecond))
	signals, _ := stub.snapshot()
	if len(signals) != 1 || signals[0] != int(syscall.SIGHUP) {
		t.Fatalf("expected SIGHUP on never-attached exec past reconnect_grace, got %v", signals)
	}
}

func TestExecManagerSignalUnsupportedFallsThroughToKill(t *testing.T) {
	m := newQuietManager(t)

	stub := &stubExecHandle{
		signalFn: func(_ int) error {
			return ErrSignalUnsupported
		},
	}
	exec := registerStub(t, m, "no-signal-1", stub)

	m.SetReapingForTest(50*time.Millisecond, 20*time.Millisecond, 10*time.Minute)

	t0 := time.Now()
	exec.attachMu.Lock()
	exec.Connected = false
	exec.LastDisconnectAt = t0
	exec.attachMu.Unlock()

	m.runCleanupOnce(t0.Add(70 * time.Millisecond))

	signals, killed := stub.snapshot()
	if len(signals) != 1 || signals[0] != int(syscall.SIGHUP) {
		t.Fatalf("expected one SIGHUP attempt, got %v", signals)
	}
	if killed != 1 {
		t.Fatalf("expected immediate Kill fallthrough on ErrSignalUnsupported, got killed=%d", killed)
	}
	if _, stillTracked := m.Get("no-signal-1"); stillTracked {
		t.Fatalf("exec should be evicted after Kill fallthrough")
	}
	exec.attachMu.Lock()
	if exec.SignaledHUP {
		exec.attachMu.Unlock()
		t.Fatalf("SignaledHUP must not be set when signal delivery failed")
	}
	exec.attachMu.Unlock()
}

func TestResolveDurationFallsBackOnUnset(t *testing.T) {
	got := resolveDuration("BOXLITE_RECONNECT_GRACE_TEST_UNSET", 7*time.Minute)
	if got != 7*time.Minute {
		t.Fatalf("expected fallback when env unset, got %v", got)
	}
}

func TestResolveDurationParsesValid(t *testing.T) {
	t.Setenv("BOXLITE_RECONNECT_GRACE_TEST_OK", "42s")
	got := resolveDuration("BOXLITE_RECONNECT_GRACE_TEST_OK", 7*time.Minute)
	if got != 42*time.Second {
		t.Fatalf("expected parsed duration, got %v", got)
	}
}

func TestResolveDurationFallsBackOnInvalid(t *testing.T) {
	t.Setenv("BOXLITE_RECONNECT_GRACE_TEST_BAD", "not-a-duration")
	got := resolveDuration("BOXLITE_RECONNECT_GRACE_TEST_BAD", 7*time.Minute)
	if got != 7*time.Minute {
		t.Fatalf("expected fallback on invalid input, got %v", got)
	}
}

func TestSdkExecSignalReturnsUnsupported(t *testing.T) {
	h := sdkExec{}
	err := h.Signal(context.Background(), int(syscall.SIGHUP))
	if !errors.Is(err, ErrSignalUnsupported) {
		t.Fatalf("expected ErrSignalUnsupported, got %v", err)
	}
}
