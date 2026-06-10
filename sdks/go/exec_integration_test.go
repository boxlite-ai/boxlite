//go:build boxlite_dev

package boxlite

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// createStartedBoxOrSkip mirrors createStartedBox but skips (rather than
// fails) when the failure mode is an infrastructure prerequisite — image
// pull (ErrStorage / ErrImage) or network reach (ErrNetwork). Used by
// integration tests that the pre-push hook may run in network-restricted
// environments where docker.io is unreachable.
func createStartedBoxOrSkip(t *testing.T, rt *Runtime, image string, opts ...BoxOption) *Box {
	t.Helper()

	ctx := context.Background()
	box, err := rt.Create(ctx, image, opts...)
	if err != nil {
		var e *Error
		if errors.As(err, &e) && (e.Code == ErrStorage || e.Code == ErrImage || e.Code == ErrNetwork) {
			t.Skipf("infrastructure prerequisite unavailable (code=%d): %v", e.Code, err)
		}
		t.Fatalf("Create: %v", err)
	}
	t.Cleanup(func() {
		_ = box.Stop(ctx)
		_ = rt.ForceRemove(ctx, box.ID())
		_ = box.Close()
	})
	if err := box.Start(ctx); err != nil {
		var e *Error
		if errors.As(err, &e) && (e.Code == ErrStorage || e.Code == ErrImage || e.Code == ErrNetwork) {
			t.Skipf("infrastructure prerequisite unavailable on Start (code=%d): %v", e.Code, err)
		}
		t.Fatalf("Start: %v", err)
	}
	return box
}

// TestIntegrationExecEnvWorkingDirTimeout proves that the three fields
// added to ExecutionOptions and Cmd in this commit actually reach the
// guest process — i.e. the Go SDK's env_pairs / workdir / timeout_secs
// plumbing makes it through the C FFI and out the other side. A single
// box is reused for all three checks because creating a VM dominates
// the test cost.
//
// Each subtest asserts a project-symbol path:
//   - Env:        Cmd.Env -> StartExecution -> env_pairs -> printenv
//   - WorkingDir: Cmd.Dir -> StartExecution -> workdir   -> pwd
//   - Timeout:    Cmd.Timeout -> StartExecution -> timeout_secs -> SIGKILL
func TestIntegrationExecEnvWorkingDirTimeout(t *testing.T) {
	rt := newTestRuntime(t)
	box := createStartedBoxOrSkip(t, rt, "alpine:latest", WithAutoRemove(false))

	// Short-lived commands (printenv, pwd) can exit so fast that
	// execution.Wait() returns before the SDK's async stdout pump has
	// delivered the final bytes. Padding the command with a brief sleep
	// gives the pump a deterministic drain window without depending on
	// host-side timing — better than a wall-clock sleep in the test.
	const drainPad = " && sleep 0.1"

	t.Run("Env reaches the guest process", func(t *testing.T) {
		cmd := box.Command("sh", "-c", "printenv BOXLITE_TEST_KEY"+drainPad)
		cmd.Env = map[string]string{
			"BOXLITE_TEST_KEY":   "bar-from-test",
			"BOXLITE_TEST_OTHER": "unused",
		}
		var out bytes.Buffer
		cmd.Stdout = &out
		if err := cmd.Run(context.Background()); err != nil {
			t.Fatalf("Cmd.Run with Env: %v", err)
		}
		got := strings.TrimSpace(out.String())
		if got != "bar-from-test" {
			t.Fatalf("env var did not reach guest: want %q, got %q", "bar-from-test", got)
		}
	})

	t.Run("Dir sets the working directory in the guest", func(t *testing.T) {
		cmd := box.Command("sh", "-c", "pwd"+drainPad)
		cmd.Dir = "/tmp"
		var out bytes.Buffer
		cmd.Stdout = &out
		if err := cmd.Run(context.Background()); err != nil {
			t.Fatalf("Cmd.Run with Dir: %v", err)
		}
		got := strings.TrimSpace(out.String())
		if got != "/tmp" {
			t.Fatalf("working dir did not reach guest: want /tmp, got %q", got)
		}
	})

	t.Run("Timeout kills a long-running process", func(t *testing.T) {
		cmd := box.Command("sleep", "30")
		cmd.Timeout = 2 * time.Second
		start := time.Now()
		err := cmd.Run(context.Background())
		elapsed := time.Since(start)
		// The exec should NOT have run to completion. We accept either
		// (a) Run returning a non-nil error, or (b) a non-zero exit
		// code observed via Cmd.ExitCode — either way the guest must
		// have been killed well before 30s elapsed.
		if elapsed >= 15*time.Second {
			t.Fatalf("Timeout did not curtail the exec: elapsed=%s, err=%v", elapsed, err)
		}
		if err == nil && cmd.ExitCode() == 0 {
			t.Fatalf("expected non-zero exit or error after Timeout; got success in %s", elapsed)
		}
	})
}

// TestIntegrationExecStdoutRace asserts that Execution.Wait does not
// return until every stdout chunk has been delivered to the user's sink
// — i.e. the drain barrier introduced for #563 holds. Pre-fix, the C
// Wait task was decoupled from the stream pumps, so a short command
// could push its Wait queue event before the late Stdout chunks landed,
// and Cmd.Run would return with a truncated buffer. The pre-existing
// `TestIntegrationExecEnvWorkingDirTimeout` papers over this with a
// `&& sleep 0.1` pad on every command (see drainPad). This test
// deliberately does NOT pad the command — that's the whole point.
//
// Repeated rounds because the race is timing-sensitive: a single
// fast/lucky run can mask it. ROUNDS=20 has caught the regression
// reliably on this machine.
func TestIntegrationExecStdoutRace(t *testing.T) {
	rt := newTestRuntime(t)
	box := createStartedBoxOrSkip(t, rt, "alpine:latest", WithAutoRemove(false))

	const rounds = 20
	const want = "marker-line\n"
	var truncated int
	for i := 0; i < rounds; i++ {
		cmd := box.Command("sh", "-c", "echo marker-line")
		var buf bytes.Buffer
		cmd.Stdout = &buf
		if err := cmd.Run(context.Background()); err != nil {
			t.Fatalf("round %d: Cmd.Run: %v", i, err)
		}
		if buf.String() != want {
			truncated++
			t.Logf("round %d: stdout=%q (want %q)", i, buf.String(), want)
		}
	}
	if truncated > 0 {
		t.Fatalf(
			"Execution.Wait returned before %d/%d stdout deliveries — "+
				"the #563 race regressed. Either Execution.Wait's "+
				"post-reap drain step (<-streamState.drained, the "+
				"os/exec awaitGoroutines analog) was removed, or the "+
				"C-side exit_pump no longer awaits the stream_done_rx "+
				"oneshots that close that channel.",
			truncated, rounds,
		)
	}
}
