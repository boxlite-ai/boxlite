//go:build boxlite_dev

// Regression test for GHSA-g6ww-w5j2-r7x3 (read-only volume remount bypass).
//
// A host directory mounted via WithVolumeReadOnly must stay read-only even
// against a malicious guest that runs `mount -o remount,rw`. Before v0.9.0
// the guest could remount the virtiofs share read-write (it had
// CAP_SYS_ADMIN) and write through to the host.
//
// Go-SDK counterpart of:
//   - sdks/python/tests/test_readonly_volume_remount.py
//   - sdks/node/tests/security-readonly-volume-remount.integration.test.ts
//   - src/boxlite/tests/security_enforcement.rs::readonly_volume_blocks_remount
package boxlite

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	roGuestMount    = "/mnt/sensitive"
	roOriginal      = "original content\n"
	roAttackPayload = "modified content"
)

func TestSecurityReadonlyVolumeRemountBypass(t *testing.T) {
	hostDir, err := os.MkdirTemp("/tmp", "virtiofs-ro-poc-")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(hostDir) })

	roFile := filepath.Join(hostDir, "read_only.txt")
	if err := os.WriteFile(roFile, []byte(roOriginal), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	rt := newTestRuntime(t)
	box := createStartedBoxOrSkip(t, rt, "alpine:latest",
		WithAutoRemove(false),
		WithVolumeReadOnly(hostDir, roGuestMount),
	)

	ctx := context.Background()

	// The share must be exposed read-only to the guest.
	mounts, err := box.Exec(ctx, "sh", "-c", "cat /proc/mounts | grep sensitive")
	if err != nil {
		t.Fatalf("Exec(mounts): %v", err)
	}
	if !strings.Contains(mounts.Stdout, " ro,") {
		t.Fatalf("volume not mounted read-only: %q", mounts.Stdout)
	}

	// Direct write is rejected (client-side MS_RDONLY active).
	write1, err := box.Exec(ctx, "sh", "-c",
		"echo '"+roAttackPayload+"' > "+roGuestMount+"/read_only.txt 2>&1")
	if err != nil {
		t.Fatalf("Exec(write1): %v", err)
	}
	if write1.ExitCode == 0 {
		t.Fatalf("initial write to read-only volume should fail; got exit=0 stdout=%q", write1.Stdout)
	}

	// ATTACK: try to remount the share read-write.
	if _, err := box.Exec(ctx, "sh", "-c",
		"mount -o remount,rw "+roGuestMount+" 2>&1"); err != nil {
		// Exec itself may report the underlying mount failure as an
		// error or a non-zero exit; either way we proceed to verify
		// the mount state and the host file.
		t.Logf("remount Exec returned err (expected/ok): %v", err)
	}

	// The mount must still be read-only after the remount attempt.
	after, err := box.Exec(ctx, "sh", "-c", "cat /proc/mounts | grep sensitive")
	if err != nil {
		t.Fatalf("Exec(mounts after): %v", err)
	}
	if !strings.Contains(after.Stdout, " ro,") || strings.Contains(after.Stdout, " rw,") {
		t.Fatalf("volume became writable after remount: %q", after.Stdout)
	}

	// A post-attack write must still fail.
	write2, err := box.Exec(ctx, "sh", "-c",
		"echo '"+roAttackPayload+"' > "+roGuestMount+"/read_only.txt 2>&1")
	if err != nil {
		t.Fatalf("Exec(write2): %v", err)
	}
	if write2.ExitCode == 0 {
		t.Fatalf("write after remount bypass should still fail; got exit=0")
	}

	// Guest-visible content unchanged.
	guestView, err := box.Exec(ctx, "cat", roGuestMount+"/read_only.txt")
	if err != nil {
		t.Fatalf("Exec(cat): %v", err)
	}
	if guestView.Stdout != roOriginal {
		t.Fatalf("guest modified the file: %q", guestView.Stdout)
	}

	// HOST VERIFICATION — the advisory's exploit oracle.
	hostBytes, err := os.ReadFile(roFile)
	if err != nil {
		t.Fatalf("ReadFile(host): %v", err)
	}
	if string(hostBytes) != roOriginal {
		t.Fatalf("GHSA-g6ww-w5j2-r7x3 regression: host file modified from inside the sandbox: got %q", string(hostBytes))
	}
}
