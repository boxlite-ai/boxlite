//go:build boxlite_dev

package boxlite

// Runtime.Close must not strand in-flight async callers. Close stops
// the drain goroutine BEFORE calling boxlite_runtime_free; without a
// "runtime closed" broadcast, any concurrent async caller (Create, Get,
// Shutdown, ImagePull, Info, Metrics, etc.) is left blocked on its
// result channel because the goroutine that drains queued events is
// dead. With a non-cancellable ctx, the caller would block forever and
// the abandonAsync cleanup goroutine (which waits on the same ch)
// never runs.
//
// Reproducer choice: ImagePull is the cleanest in-flight async op for
// this test because Pull's Tokio task spends real wall-clock time on
// DNS resolution + TCP connection. Create's Tokio task completes
// locally in milliseconds (the actual image pull is deferred to start
// time). Pulling against an unreachable registry guarantees a
// multi-second in-flight window during which Close races.

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
		t.Fatalf("Pull stranded for %v after Close: drain goroutine "+
			"stopped before the result channel could be delivered, and "+
			"the in-flight caller has no signal to wake on", elapsed)
	}
}
