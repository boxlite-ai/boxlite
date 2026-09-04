//go:build boxlite_dev

package boxlite

import (
	"context"
	"sync"
	"testing"
	"time"
)

// Producer command — emits ~10 MB of stdout. Same shape as the Python
// e2e back-pressure probe so the two tests are directly comparable.
const unreadProducerCmd = "for i in $(seq 1 200000); do echo line-$i-padding-padding-padding; done"

// TestIntegrationUnreadLargeStdoutDoesNotBlockSameBox asserts that an
// execution whose stdout sink is nil (no Writer, no OnStdout callback)
// does NOT delay a concurrent execution on the same box. This pins the
// architectural concern raised after #563: the Go SDK runs a single
// runtime-level drainLoop goroutine that dispatches every execution's
// stream events serially. If a slow sink could block that goroutine,
// every other execution in the runtime would stall behind it.
//
// "Not reading" maps to passing &ExecutionOptions{} with nil Stdout
// and nil OnStdout — the deliverStdout fast path then no-ops on each
// chunk. The expected behaviour is that the drain loop processes
// those chunks in nanoseconds and never blocks B.
func TestIntegrationUnreadLargeStdoutDoesNotBlockSameBox(t *testing.T) {
	rt := newTestRuntime(t)
	box := createStartedBoxOrSkip(t, rt, "alpine:latest", WithAutoRemove(false))

	ctx := context.Background()

	// 1) Start the producer — nil sinks. deliverStdout will be called
	//    per chunk but find both s.stdout and s.onStdout nil and exit
	//    fast.
	exA, err := box.StartExecution(ctx, "sh", []string{"-c", unreadProducerCmd}, &ExecutionOptions{})
	if err != nil {
		t.Fatalf("StartExecution A: %v", err)
	}
	t.Cleanup(func() {
		// Make sure A's Wait is unblocked even if the test fails. Wait
		// won't return until streamState.drained closes, which (per
		// the post-#563 contract) means after the C exit_pump has
		// drained every stream chunk.
		_, _ = exA.Wait(ctx)
		_ = exA.Close()
	})

	// 2) Brief head start so the producer has begun pumping chunks
	//    into the drain loop. 200 ms is way past first-chunk latency.
	time.Sleep(200 * time.Millisecond)

	// 3) Fast exec on the same box.
	start := time.Now()
	exB, err := box.StartExecution(ctx, "echo", []string{"fast-b"}, &ExecutionOptions{})
	if err != nil {
		t.Fatalf("StartExecution B: %v", err)
	}
	code, err := exB.Wait(ctx)
	elapsed := time.Since(start)
	_ = exB.Close()
	if err != nil {
		t.Fatalf("exB.Wait: %v", err)
	}

	t.Logf("[same-box] elapsed=%v rc=%d", elapsed, code)
	if elapsed > 5*time.Second {
		t.Fatalf(
			"exB took %v while A's huge nil-sink stdout was being dispatched — "+
				"same-box back-pressure / blocking suspected (drain loop stalled)",
			elapsed,
		)
	}
	if code != 0 {
		t.Errorf("exB exit code = %d, want 0", code)
	}
}

// TestIntegrationUnreadLargeStdoutDoesNotBlockCrossBox does the same
// probe but with the producer on box_a and the fast exec on a separate
// box_b. Same drain loop (it's runtime-level, not box-level), so the
// expected answer is identical: B should not be delayed.
func TestIntegrationUnreadLargeStdoutDoesNotBlockCrossBox(t *testing.T) {
	rt := newTestRuntime(t)
	boxA := createStartedBoxOrSkip(t, rt, "alpine:latest", WithAutoRemove(false))
	boxB := createStartedBoxOrSkip(t, rt, "alpine:latest", WithAutoRemove(false))

	ctx := context.Background()

	exA, err := boxA.StartExecution(ctx, "sh", []string{"-c", unreadProducerCmd}, &ExecutionOptions{})
	if err != nil {
		t.Fatalf("StartExecution A: %v", err)
	}
	t.Cleanup(func() {
		_, _ = exA.Wait(ctx)
		_ = exA.Close()
	})

	time.Sleep(200 * time.Millisecond)

	start := time.Now()
	exB, err := boxB.StartExecution(ctx, "echo", []string{"fast-b"}, &ExecutionOptions{})
	if err != nil {
		t.Fatalf("StartExecution B: %v", err)
	}
	code, err := exB.Wait(ctx)
	elapsed := time.Since(start)
	_ = exB.Close()
	if err != nil {
		t.Fatalf("exB.Wait: %v", err)
	}

	t.Logf("[cross-box] elapsed=%v rc=%d", elapsed, code)
	if elapsed > 5*time.Second {
		t.Fatalf(
			"exB on box_b took %v while box_a's A had a huge unread stdout — "+
				"cross-box back-pressure / blocking suspected (drain loop stalled)",
			elapsed,
		)
	}
	if code != 0 {
		t.Errorf("exB exit code = %d, want 0", code)
	}
}

// blockingSink is an io.Writer that parks the goroutine calling Write until
// the test releases it. The first Write closes `entered` so the test can
// observe — without a wall-clock sleep — that delivery has reached the sink,
// then blocks on `release` (never sent during the test body) so the caller
// stays parked. Because the Go SDK dispatches every stream callback inline on
// the single per-Runtime drain goroutine (runtime.go:283 -> deliverStdout,
// exec.go:118), parking inside Write parks the only consumer of the shared
// event FIFO.
type blockingSink struct {
	entered     chan struct{}
	release     chan struct{}
	enteredOnce sync.Once
}

func newBlockingSink() *blockingSink {
	return &blockingSink{
		entered: make(chan struct{}),
		release: make(chan struct{}),
	}
}

func (s *blockingSink) Write(p []byte) (int, error) {
	s.enteredOnce.Do(func() { close(s.entered) })
	<-s.release
	return len(p), nil
}

// TestIntegrationStdoutBlockingSinkStallsRuntimeDrain reproduces head-of-line
// blocking on the shared drain goroutine. A first execution streams stdout
// into a sink that blocks forever; because deliverStdout runs inline on the
// runtime's single drain goroutine, that goroutine wedges and can no longer
// dispatch ANY event for ANY execution on the same Runtime. A second,
// trivial execution on the same box therefore never observes its Wait
// completion and its caller-supplied context deadline fires instead.
//
// This asserts the DESIRED behaviour — the second exec should complete
// promptly regardless of the first exec's misbehaving sink. With delivery on
// the shared drain thread today, the assertion FAILS (the probe times out),
// which is the reproduction. A fix that delivers stream output off the drain
// thread would turn this green.
func TestIntegrationStdoutBlockingSinkStallsRuntimeDrain(t *testing.T) {
	rt := newTestRuntime(t)
	box := createStartedBoxOrSkip(t, rt, "alpine:latest", WithAutoRemove(false))

	sink := newBlockingSink()

	// Execution A: emit one stdout chunk, then stay alive. The chunk is
	// delivered into `sink`, parking the drain goroutine. We never Wait on A.
	execA, err := box.StartExecution(context.Background(), "sh", []string{"-c", "echo drain-wedge; sleep 60"}, &ExecutionOptions{
		Stdout: sink,
	})
	if err != nil {
		t.Fatalf("StartExecution(A): %v", err)
	}

	// Tear down in the order that lets the wedged runtime shut down cleanly:
	// release the parked drain goroutine FIRST (close release), then free
	// execution A. This cleanup is registered LAST, so LIFO runs it BEFORE
	// the box/runtime cleanups registered inside the helpers — otherwise
	// rt.Close -> stopDrain would block forever waiting on the wedged drain.
	t.Cleanup(func() {
		close(sink.release)
		_ = execA.Close()
	})

	// Wait for the drain goroutine to actually enter the blocking sink before
	// probing. This is an event wait (channel), not a timing sleep: once
	// `entered` is closed, the single drain goroutine is provably parked.
	select {
	case <-sink.entered:
	case <-time.After(20 * time.Second):
		t.Skip("execution A never produced stdout within 20s; runtime/guest unavailable, cannot exercise the drain-blocking path")
	}

	// Execution B: a trivial command on the SAME runtime. Its Wait completion
	// is enqueued behind A's still-pending stdout in the one FIFO, and the
	// only consumer (the drain goroutine) is parked in sink.Write. So B's
	// Wait can never be dispatched; box.Exec falls through to its context
	// deadline.
	ctxB, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	start := time.Now()
	res, err := box.Exec(ctxB, "echo", "probe")
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("HEAD-OF-LINE BLOCKING REPRODUCED: a second exec on the same Runtime "+
			"did not complete in %s because the drain goroutine is wedged delivering "+
			"execution A's stdout to a blocking sink: %v", elapsed, err)
	}
	if res.Stdout != "probe\n" {
		t.Fatalf("probe exec returned unexpected stdout %q (want %q)", res.Stdout, "probe\n")
	}
}
