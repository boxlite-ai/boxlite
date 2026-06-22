//go:build boxlite_dev

package boxlite

import (
	"bytes"
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

// waitWatchdog runs fn (which performs a blocking Wait) and fails the test if it
// does not return within d — i.e. the exec hung instead of reporting exit.
func waitWatchdog(t *testing.T, d time.Duration, what string, fn func()) {
	t.Helper()
	done := make(chan struct{})
	go func() { fn(); close(done) }()
	select {
	case <-done:
	case <-time.After(d):
		t.Fatalf("HANG: %s did not return within %s (Wait never unblocked)", what, d)
	}
}

// TestIntegrationExecDrainMatrix is the regression matrix for PR #812: across
// termination modes (normal, timeout->SIGTERM, hard SIGKILL, explicit Kill,
// backgrounded child holding stdout) and stream shapes (stdout, stderr, TTY),
// Execution.Wait must return promptly with the right exit code and full output
// instead of hanging. Runtime.Close mid-exec is covered separately below.
func TestIntegrationExecDrainMatrix(t *testing.T) {
	rt := newTestRuntime(t)
	box := createStartedBoxOrSkip(t, rt, "alpine:latest", WithAutoRemove(false))

	// run starts an exec, watchdogs the Wait, and returns the exit code.
	run := func(t *testing.T, opts *ExecutionOptions, args []string, watchdog time.Duration, kill func(*Execution)) int {
		t.Helper()
		exec, err := box.StartExecution(context.Background(), "sh", args, opts)
		if err != nil {
			t.Fatalf("StartExecution: %v", err)
		}
		defer exec.Close()
		var code int
		if kill != nil {
			go kill(exec)
		}
		waitWatchdog(t, watchdog, t.Name(), func() { code, _ = exec.Wait(context.Background()) })
		return code
	}

	t.Run("normal-exit", func(t *testing.T) {
		var out bytes.Buffer
		code := run(t, &ExecutionOptions{Stdout: &out}, []string{"-c", "echo hi; exit 5"}, 12*time.Second, nil)
		if code != 5 {
			t.Errorf("exit = %d, want 5", code)
		}
		if out.Len() == 0 {
			t.Errorf("stdout empty, want output before exit")
		}
	})

	t.Run("timeout-SIGTERM", func(t *testing.T) {
		var out bytes.Buffer
		code := run(t, &ExecutionOptions{Stdout: &out, Timeout: 2 * time.Second},
			[]string{"-c", "echo before; sleep 30"}, 14*time.Second, nil)
		if code == 0 {
			t.Errorf("exit = 0, want non-zero (killed by timeout)")
		}
		if !bytes.Contains(out.Bytes(), []byte("before")) {
			t.Errorf("pre-kill stdout lost: %q", out.String())
		}
	})

	t.Run("hard-SIGKILL-escalate", func(t *testing.T) {
		// trap+ignore SIGTERM so the timeout must escalate to SIGKILL.
		var out bytes.Buffer
		code := run(t, &ExecutionOptions{Stdout: &out, Timeout: 2 * time.Second},
			[]string{"-c", "trap '' TERM; echo before; while :; do sleep 0.2; done"}, 25*time.Second, nil)
		if code == 0 {
			t.Errorf("exit = 0, want non-zero (SIGKILL)")
		}
		if !bytes.Contains(out.Bytes(), []byte("before")) {
			t.Errorf("pre-kill stdout lost: %q", out.String())
		}
	})

	t.Run("bg-child-holds-stdout", func(t *testing.T) {
		// Main exits 0 but a backgrounded child inherits stdout; the pump may
		// not see a natural EOF. Wait must still return (drain gives up).
		var out bytes.Buffer
		code := run(t, &ExecutionOptions{Stdout: &out}, []string{"-c", "echo hi; sleep 30 &"}, 12*time.Second, nil)
		if code != 0 {
			t.Errorf("exit = %d, want 0", code)
		}
		if !bytes.Contains(out.Bytes(), []byte("hi")) {
			t.Errorf("stdout lost: %q", out.String())
		}
	})

	t.Run("explicit-Kill", func(t *testing.T) {
		code := run(t, &ExecutionOptions{}, []string{"-c", "echo before; sleep 30"}, 12*time.Second,
			func(e *Execution) {
				time.Sleep(700 * time.Millisecond)
				_ = e.Kill(context.Background())
			})
		if code == 0 {
			t.Errorf("exit = 0, want non-zero (killed)")
		}
	})

	t.Run("stderr-separate", func(t *testing.T) {
		var out, errb bytes.Buffer
		code := run(t, &ExecutionOptions{Stdout: &out, Stderr: &errb},
			[]string{"-c", "echo OUT; echo ERRLINE 1>&2; exit 3"}, 12*time.Second, nil)
		if code != 3 {
			t.Errorf("exit = %d, want 3", code)
		}
		if !bytes.Contains(out.Bytes(), []byte("OUT")) || !bytes.Contains(errb.Bytes(), []byte("ERRLINE")) {
			t.Errorf("stream loss: stdout=%q stderr=%q", out.String(), errb.String())
		}
	})

	t.Run("tty-normal", func(t *testing.T) {
		var out bytes.Buffer
		code := run(t, &ExecutionOptions{TTY: true, Stdout: &out}, []string{"-c", "echo hi; exit 0"}, 12*time.Second, nil)
		if code != 0 {
			t.Errorf("exit = %d, want 0", code)
		}
		if out.Len() == 0 {
			t.Errorf("TTY stdout empty")
		}
	})

	t.Run("tty-timeout", func(t *testing.T) {
		var out bytes.Buffer
		code := run(t, &ExecutionOptions{TTY: true, Stdout: &out, Timeout: 2 * time.Second},
			[]string{"-c", "echo hi; sleep 30"}, 14*time.Second, nil)
		if code == 0 {
			t.Errorf("exit = 0, want non-zero (timeout)")
		}
	})
}

// TestIntegrationExecRuntimeCloseUnblocksWait covers the e.closing path: closing
// the Runtime while an exec is in flight must unblock Wait with ErrRuntimeClosed
// rather than hanging.
func TestIntegrationExecRuntimeCloseUnblocksWait(t *testing.T) {
	home, err := os.MkdirTemp("/tmp", "boxlite-rtclose-")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	rt, err := NewRuntime(WithHomeDir(home))
	if err != nil {
		var e *Error
		if errors.As(err, &e) && (e.Code == ErrUnsupported || e.Code == ErrUnsupportedEngine) {
			t.Skipf("runtime not available: %v", err)
		}
		t.Fatalf("NewRuntime: %v", err)
	}
	box := createStartedBoxOrSkip(t, rt, "alpine:latest", WithAutoRemove(false))

	exec, err := box.StartExecution(context.Background(), "sh", []string{"-c", "echo running; sleep 30"}, &ExecutionOptions{})
	if err != nil {
		t.Fatalf("StartExecution: %v", err)
	}
	defer exec.Close()

	errCh := make(chan error, 1)
	go func() { _, e := exec.Wait(context.Background()); errCh <- e }()
	time.Sleep(700 * time.Millisecond)
	go func() { _ = rt.Close() }()

	select {
	case e := <-errCh:
		if !errors.Is(e, ErrRuntimeClosed) {
			t.Fatalf("Wait err = %v, want ErrRuntimeClosed", e)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("HANG: Wait did not unblock on Runtime.Close")
	}
}
