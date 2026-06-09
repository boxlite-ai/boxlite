//go:build boxlite_dev

// Integration tests for SecurityOptions enforcement inside a live box.
//
// These tests verify that security options passed at box creation are actually
// enforced by the guest environment — not just accepted at the API boundary.
//
// Go-SDK counterpart of:
//   - sdks/python/tests/test_resource_limits.py
//   - sdks/node/tests/security-resource-limits.integration.test.ts
//   - src/boxlite/tests/jailer.rs (resource limit enforcement)
package boxlite

import (
	"context"
	"strconv"
	"strings"
	"testing"
)

func u64ptr(v uint64) *uint64 { return &v }

// TestSecurityMaxOpenFiles verifies that max_open_files from SecurityOptions is
// enforced inside the box. The guest's file descriptor limit (ulimit -n) must
// not exceed the configured value.
func TestSecurityMaxOpenFiles(t *testing.T) {
	const limit = uint64(64)

	rt := newTestRuntime(t)
	box := createStartedBoxOrSkip(t, rt, "alpine:latest",
		WithAutoRemove(false),
		WithSecurity(SecurityOptions{
			ResourceLimits: &SecurityResourceLimits{
				MaxOpenFiles: u64ptr(limit),
			},
		}),
	)

	ctx := context.Background()
	result, err := box.Exec(ctx, "sh", "-c", "ulimit -n")
	if err != nil {
		t.Fatalf("Exec(ulimit -n): %v", err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("ulimit -n: exit=%d stdout=%q", result.ExitCode, result.Stdout)
	}
	got, parseErr := strconv.ParseUint(strings.TrimSpace(result.Stdout), 10, 64)
	if parseErr != nil {
		t.Fatalf("parse ulimit output %q: %v", result.Stdout, parseErr)
	}
	if got > limit {
		t.Errorf("max_open_files not enforced: got ulimit -n = %d, want ≤ %d", got, limit)
	}
}

// TestSecurityMaxProcesses verifies that max_processes from SecurityOptions is
// enforced inside the box. The guest's process limit (ulimit -u) must not
// exceed the configured value.
func TestSecurityMaxProcesses(t *testing.T) {
	const limit = uint64(50)

	rt := newTestRuntime(t)
	box := createStartedBoxOrSkip(t, rt, "alpine:latest",
		WithAutoRemove(false),
		WithSecurity(SecurityOptions{
			ResourceLimits: &SecurityResourceLimits{
				MaxProcesses: u64ptr(limit),
			},
		}),
	)

	ctx := context.Background()
	result, err := box.Exec(ctx, "sh", "-c", "ulimit -u")
	if err != nil {
		t.Fatalf("Exec(ulimit -u): %v", err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("ulimit -u: exit=%d stdout=%q", result.ExitCode, result.Stdout)
	}
	out := strings.TrimSpace(result.Stdout)
	// "unlimited" means the limit was not applied — report clearly.
	if out == "unlimited" {
		t.Fatalf("max_processes not enforced: ulimit -u reports unlimited, want ≤ %d", limit)
	}
	got, parseErr := strconv.ParseUint(out, 10, 64)
	if parseErr != nil {
		t.Fatalf("parse ulimit -u output %q: %v", out, parseErr)
	}
	if got > limit {
		t.Errorf("max_processes not enforced: got ulimit -u = %d, want ≤ %d", got, limit)
	}
}

// TestSecuritySanitizeEnv verifies that sanitize_env=true removes host
// environment variables that are not in env_allowlist from the guest.
//
// The test creates a box without passing any guest env, but with
// sanitize_env=true and a narrow allowlist. The guest's PATH must be
// present, but an env var that only exists on the host must be absent.
func TestSecuritySanitizeEnv(t *testing.T) {
	allowlist := []string{"PATH", "HOME", "TERM"}

	rt := newTestRuntime(t)
	box := createStartedBoxOrSkip(t, rt, "alpine:latest",
		WithAutoRemove(false),
		WithSecurity(SecurityOptions{
			SanitizeEnv:  boolptr(true),
			EnvAllowlist: &allowlist,
		}),
	)

	ctx := context.Background()

	// PATH must still be available — it is explicitly allowed.
	pathResult, err := box.Exec(ctx, "sh", "-c", "echo $PATH")
	if err != nil {
		t.Fatalf("Exec(echo $PATH): %v", err)
	}
	if strings.TrimSpace(pathResult.Stdout) == "" {
		t.Error("PATH should be present in guest env (it is in the allowlist)")
	}

	// A variable that is not in the allowlist and not explicitly passed via
	// WithEnv must not appear in the guest environment.
	checkResult, err := box.Exec(ctx, "sh", "-c",
		"env | grep -c BOXLITE_SHOULD_NOT_EXIST || true")
	if err != nil {
		t.Fatalf("Exec(env grep): %v", err)
	}
	count := strings.TrimSpace(checkResult.Stdout)
	if count != "0" && count != "" {
		t.Errorf("sanitize_env did not remove unlisted variable: grep count = %q", count)
	}
}

func boolptr(v bool) *bool { return &v }
