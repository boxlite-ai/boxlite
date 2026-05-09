//go:build boxlite_dev

package boxlite

// Codex round-3 finding #3 reproducer: Runtime.Close stops the drain
// goroutine BEFORE calling boxlite_runtime_free. Any concurrent async
// caller (Create, Get, Shutdown, ImagePull, Info, Metrics, etc.) is
// blocked on `select { case res := <-ch: case <-ctx.Done(): }`. After
// stopDrain, the result channel `ch` cannot receive anything because
// the only goroutine that calls C.boxlite_runtime_drain (and dispatches
// queued events to the callback that writes to `ch`) is dead. With a
// non-cancellable ctx, the caller blocks forever and the abandonAsync
// cleanup goroutine never runs (its detached goroutine waits on the
// same ch).
//
// Reproducer choice: ImagePull is the cleanest in-flight async op for
// this test because Pull's Tokio task spends real wall-clock time on
// DNS resolution + TCP connection to the registry. Create's Tokio task
// completes locally in milliseconds (the actual image pull is
// deferred to start time), so Create cannot reliably reproduce the
// strand. ImagePull against an unreachable registry guarantees a
// multi-second in-flight window during which Close races.
//
// BEFORE FIX (today): Pull blocks for the full 3-second timeout
// because the Tokio task pushes its result event into a queue that
// has no drainer. The test fails with "Pull stranded after Close".
// AFTER FIX: Close broadcasts a "runtime closed" signal that all
// in-flight async callers respond to (returning ErrRuntimeClosed
// or some non-nil error). Pull wakes up within ms.

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

func TestRuntimeCloseDoesNotStrandPendingPull(t *testing.T) {
	homeDir, err := os.MkdirTemp("/tmp", "boxlite-go-close-strand-pull-")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() {
		_ = os.RemoveAll(homeDir)
	})

	rt, err := NewRuntime(WithHomeDir(homeDir))
	if err != nil {
		var e *Error
		if errors.As(err, &e) && (e.Code == ErrUnsupported || e.Code == ErrUnsupportedEngine) {
			t.Skipf("runtime not available: %v", err)
		}
		t.Fatalf("NewRuntime: %v", err)
	}

	images, err := rt.Images()
	if err != nil {
		t.Fatalf("Images(): %v", err)
	}

	done := make(chan error, 1)
	go func() {
		// Unreachable registry: TCP connect to 192.0.2.1 (TEST-NET-1
		// per RFC 5737) blackholes for the OS connect timeout (~minute
		// on macOS). Plenty of in-flight time. ctx is non-cancellable
		// so the only way Pull can return is the result channel.
		ctx := context.Background()
		_, pullErr := images.Pull(ctx, "192.0.2.1/boxlite-strand-test/nope:latest")
		done <- pullErr
	}()

	// Give the goroutine time to call into boxlite_image_pull and
	// reach `select { case res := <-ch: }`. 200ms is overkill for
	// the synchronous portion (cgo call); the Tokio task is then
	// blocked on TCP connect for the duration of this test.
	time.Sleep(200 * time.Millisecond)

	closeStart := time.Now()
	if closeErr := rt.Close(); closeErr != nil {
		t.Fatalf("Close: %v", closeErr)
	}

	select {
	case pullErr := <-done:
		if pullErr == nil {
			t.Fatal("Pull returned nil after Close — expected non-nil error " +
				"(real pull cannot succeed against an unreachable registry)")
		}
		t.Logf("Pull unblocked %v after Close; err = %v",
			time.Since(closeStart), pullErr)
	case <-time.After(3 * time.Second):
		elapsed := time.Since(closeStart)
		t.Fatalf("Pull stranded for %v after Close — broken code blocks "+
			"forever (round-3 #3): drain goroutine stopped before "+
			"the result channel could be delivered, and the in-flight "+
			"caller has no signal to wake on", elapsed)
	}
}
