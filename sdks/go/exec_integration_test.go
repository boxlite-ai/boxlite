//go:build boxlite_dev

package boxlite

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"
)

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
	box := createStartedBox(t, rt, "alpine:latest", WithAutoRemove(false))

	t.Run("Env reaches the guest process", func(t *testing.T) {
		cmd := box.Command("printenv", "BOXLITE_TEST_KEY")
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
		cmd := box.Command("pwd")
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
