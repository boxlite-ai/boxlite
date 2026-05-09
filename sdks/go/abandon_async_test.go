package boxlite

// Codex finding #2 reproducer: every async Go SDK method used to leak its
// `cgo.Handle` (and, for `Runtime.Create`, an entire live VM) when the
// caller's context cancelled before the C-side Tokio task completed.
// `abandonAsync` / `abandonAsyncErr` / `drainAndDelete` move that cleanup
// onto a detached goroutine so the caller still returns ctx.Err() promptly
// AND the cgo-side resources are reclaimed.
//
// BEFORE FIX: no helper existed; the cancel branch simply returned
// `ctx.Err()` and never deleted the handle. These tests would have failed
// to compile (helpers absent) — the actual cgo.Handle leak is observable
// only at scale; the helper-level tests verify the cleanup contract.
// AFTER FIX: each test asserts the helper deletes the handle and runs the
// optional cleanup with the right value/error semantics.

import (
	"runtime/cgo"
	"testing"
	"time"
)

// expectAlreadyDeleted asserts that calling Delete on `h` panics, which is
// the documented evidence that the helper already deleted it. Polling the
// helper directly via Delete-and-recover is unsafe because the *first*
// Delete races the helper; instead the test sleeps a short interval to
// give the detached goroutine room to run, then asserts a follow-up Delete
// fails.
func expectAlreadyDeleted(t *testing.T, h cgo.Handle) {
	t.Helper()
	defer func() {
		if r := recover(); r == nil {
			t.Fatalf("cgo.Handle was NOT deleted by the helper")
		}
	}()
	h.Delete()
}

func TestAbandonAsync_RunsCleanupOnSuccess(t *testing.T) {
	ch := make(chan handleResult[int], 1)
	h := cgo.NewHandle(ch)
	cleanupRan := make(chan int, 1)
	closing := make(chan struct{}) // never fires

	abandonAsync(ch, h, closing, func(v int) { cleanupRan <- v })

	// Simulate the eventual Tokio task completion.
	ch <- handleResult[int]{value: 42, err: nil}

	select {
	case v := <-cleanupRan:
		if v != 42 {
			t.Fatalf("cleanup got %d, want 42", v)
		}
	case <-time.After(time.Second):
		t.Fatal("cleanup did not run within 1s")
	}

	// Helper has already drained the channel (cleanup ran) — give it a
	// moment to also call Delete, then assert.
	time.Sleep(100 * time.Millisecond)
	expectAlreadyDeleted(t, h)
}

func TestAbandonAsync_SkipsCleanupOnError(t *testing.T) {
	ch := make(chan handleResult[int], 1)
	h := cgo.NewHandle(ch)
	cleanupRan := make(chan int, 1)
	closing := make(chan struct{})

	abandonAsync(ch, h, closing, func(v int) { cleanupRan <- v })

	ch <- handleResult[int]{err: &Error{Code: ErrInternal, Message: "boom"}}

	// Cleanup should NOT run on error. Wait briefly to confirm.
	select {
	case v := <-cleanupRan:
		t.Fatalf("cleanup ran unexpectedly with value %d on error path", v)
	case <-time.After(100 * time.Millisecond):
		// expected
	}

	expectAlreadyDeleted(t, h)
}

func TestAbandonAsyncErr_DeletesHandle(t *testing.T) {
	ch := make(chan error, 1)
	h := cgo.NewHandle(ch)
	closing := make(chan struct{})

	abandonAsyncErr(ch, h, closing)
	ch <- nil

	time.Sleep(100 * time.Millisecond)
	expectAlreadyDeleted(t, h)
}

func TestDrainAndDelete_DeletesHandle(t *testing.T) {
	ch := make(chan infoListResult, 1)
	h := cgo.NewHandle(ch)
	closing := make(chan struct{})

	drainAndDelete(ch, h, closing)
	ch <- infoListResult{}

	time.Sleep(100 * time.Millisecond)
	expectAlreadyDeleted(t, h)
}

// ─── Round-3 #3: Close wakes detached cleanup goroutines ───────────────────

func TestAbandonAsync_RespondsToCloseSignal(t *testing.T) {
	ch := make(chan handleResult[int], 1)
	h := cgo.NewHandle(ch)
	closing := make(chan struct{})
	cleanupRan := make(chan int, 1)

	abandonAsync(ch, h, closing, func(v int) { cleanupRan <- v })

	// Close fires while ch is empty. The detached goroutine must wake on
	// `<-closing` instead of waiting forever for a result that the C side
	// will never deliver (because the runtime is closing).
	close(closing)

	// Cleanup MUST NOT run on the closing path — the runtime is going
	// away, all its boxes/images are about to be released by
	// boxlite_runtime_free anyway.
	select {
	case v := <-cleanupRan:
		t.Fatalf("cleanup ran on closing path with value %d; expected skip", v)
	case <-time.After(100 * time.Millisecond):
		// expected
	}

	expectAlreadyDeleted(t, h)
}

func TestAbandonAsyncErr_RespondsToCloseSignal(t *testing.T) {
	ch := make(chan error, 1)
	h := cgo.NewHandle(ch)
	closing := make(chan struct{})

	abandonAsyncErr(ch, h, closing)
	close(closing)

	time.Sleep(100 * time.Millisecond)
	expectAlreadyDeleted(t, h)
}

func TestDrainAndDelete_RespondsToCloseSignal(t *testing.T) {
	ch := make(chan infoListResult, 1)
	h := cgo.NewHandle(ch)
	closing := make(chan struct{})

	drainAndDelete(ch, h, closing)
	close(closing)

	time.Sleep(100 * time.Millisecond)
	expectAlreadyDeleted(t, h)
}

// ─── Round-2 Codex finding #3 regression guard ─────────────────────────────
//
// Round-1 deliberately leaked the per-execution `cgo.Handle` because the
// stdout/stderr/exit callbacks on the C side were not strictly ordered, so
// deleting the handle in the exit callback would race a concurrent stream
// callback. Round-2 fix has two parts:
//   - Rust: `exit_pump` now awaits each stream pump's `oneshot::Sender<()>`
//     before pushing the Exit event, and `execution_free` synthesises an
//     Exit on teardown so abort paths still terminate the dispatch chain.
//   - Go: `goBoxliteOnExit` calls `h.Delete()` on the way out.
//
// The test directly invokes `goBoxliteOnExit` against a fresh cgo.Handle
// and verifies the handle is deleted afterwards.
//
// BEFORE FIX: handle stays live (Delete on a live handle is a no-op-with-
// panic; second Delete panics — but the FIRST Delete here would succeed
// because the helper didn't run).
// AFTER FIX: helper deletes; test's follow-up Delete panics, which we
// observe via `expectAlreadyDeleted`.

func TestExecutionStreamState_HandleDeletedOnExit(t *testing.T) {
	state := newExecutionStreamState(ExecutionOptions{})
	streamHandle := cgo.NewHandle(state)

	// Synthesize the C-side exit dispatch by calling the Go body of
	// goBoxliteOnExit. (We can't call goBoxliteOnExit directly from a
	// _test.go file because cgo isn't supported there; `dispatchExit` is
	// the test-friendly extraction.)
	dispatchExit(0, streamHandle)

	// After the round-2 fix, the handle is deleted in goBoxliteOnExit.
	expectAlreadyDeleted(t, streamHandle)

	// State should also have observed the exit delivery.
	if !state.released.Load() {
		t.Fatal("executionStreamState.released was not set by deliverExit")
	}
}
