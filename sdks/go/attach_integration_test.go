//go:build boxlite_dev

package boxlite

import (
	"bytes"
	"context"
	"sync"
	"testing"
	"time"
)

// syncBuffer is a goroutine-safe io.Writer: the SDK delivers stdout from an
// async pump goroutine while the test reads concurrently.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// waitForContains polls sink until it contains want or the deadline passes.
func waitForContains(sink *syncBuffer, want string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if bytes.Contains([]byte(sink.String()), []byte(want)) {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return bytes.Contains([]byte(sink.String()), []byte(want))
}

// TestIntegrationAttachExecutionReplaysById proves the reconnect vertical:
// a caller that pins ExecutionID on StartExecution can later reattach to the
// *same still-running guest process* by that id via AttachExecution, and the
// guest replays scrollback to the reconnected stream.
//
// This is the end-to-end shape the runner relies on to reconnect after a
// restart (persist the id, reattach on boot). It exercises every layer of
// the id path: Go ExecutionOptions.ExecutionID -> C BoxliteCommand.execution_id
// -> BoxCommand.execution_id -> ExecRequest.execution_id -> guest registry key
// -> AttachExecution lookup -> guest scrollback replay.
//
// Two-side verification of the id plumbing: revert build_exec_request back to
// `execution_id: None` (guest mints its own uuid) and AttachExecution(fixedID)
// fails with "Execution not found" — the attach can never find the process.
func TestIntegrationAttachExecutionReplaysById(t *testing.T) {
	rt := newTestRuntime(t)
	box := createStartedBoxOrSkip(t, rt, "alpine:latest", WithAutoRemove(false))

	ctx := context.Background()
	const fixedID = "attach-repro-fixed-id-0001"
	const marker = "REPLAY_MARKER_9f3a"

	// Long-lived so the process is still alive when we reattach: emit the
	// marker, then block for a while. `cat` blocks on stdin (no EOF) so the
	// exec stays registered on the guest across the handle swap.
	first, err := box.StartExecution(ctx, "sh", []string{"-c", "echo " + marker + "; cat"}, &ExecutionOptions{
		ExecutionID: fixedID,
		Stdout:      &syncBuffer{}, // first sink; we only assert the process started below
	})
	if err != nil {
		t.Fatalf("StartExecution: %v", err)
	}

	// Re-run StartExecution's sink through a handle we can observe. We can't
	// read the first sink's contents (it's inlined above), so prove liveness
	// by attaching and observing the replayed marker instead — that's the
	// property under test anyway.
	_ = first

	// Drop the original host handle WITHOUT killing the guest process, modeling
	// a runner that lost its in-memory Execution across a restart while the
	// detached box kept running. Close frees the host handle/pumps; the guest
	// process and its output ring survive.
	if err := first.Close(); err != nil {
		t.Fatalf("first.Close: %v", err)
	}

	// Reattach by the pinned id. Pre-fix (guest-minted uuid) this returns
	// "Execution not found".
	replay := &syncBuffer{}
	second, err := box.AttachExecution(ctx, fixedID, &ExecutionOptions{Stdout: replay})
	if err != nil {
		t.Fatalf("AttachExecution(%q): %v — the pinned id never reached the guest registry", fixedID, err)
	}
	t.Cleanup(func() {
		_ = second.Kill(context.Background())
		_ = second.Close()
	})

	if !waitForContains(replay, marker, 5*time.Second) {
		t.Fatalf("reattached stream never replayed %q (got %q) — scrollback replay or id lookup is broken",
			marker, replay.String())
	}
}
