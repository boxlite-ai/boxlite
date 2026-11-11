// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package checkpoint

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"golang.org/x/sys/unix"
)

func TestCheckpointOperationsRejectInvalidTargetsAndUnsafeLocks(t *testing.T) {
	for _, target := range []string{"", strings.Repeat("x", 129), "target\x00suffix"} {
		root := filepath.Join(t.TempDir(), "untouched")
		if _, err := (Operations{Root: root}).Lock(t.Context(), target); err == nil {
			t.Fatal("invalid target accepted")
		}
		if _, err := os.Stat(root); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("invalid target created a directory: %v", err)
		}
	}
	if _, err := (Operations{}).Lock(t.Context(), "target"); err == nil {
		t.Fatal("empty work directory accepted")
	}
	for _, scenario := range []string{"file-root", "symlink-lock", "fifo-lock"} {
		t.Run(scenario, func(t *testing.T) {
			o := Operations{Root: filepath.Join(t.TempDir(), "operations")}
			lease, err := o.Lock(t.Context(), "target")
			if err != nil {
				t.Fatal(err)
			}
			lockPath := lease.file.Name()
			if err := lease.Close(); err != nil {
				t.Fatal(err)
			}
			if err := lease.Close(); err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "file-root":
				o.Root = filepath.Join(o.Root, "file")
				if err := os.WriteFile(o.Root, []byte("occupied"), 0600); err != nil {
					t.Fatal(err)
				}
			default:
				if err := os.Remove(lockPath); err != nil {
					t.Fatal(err)
				}
				if scenario == "symlink-lock" {
					if err := os.Symlink(filepath.Join(t.TempDir(), "other"), lockPath); err != nil {
						t.Fatal(err)
					}
				} else if err := unix.Mkfifo(lockPath, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := o.Lock(t.Context(), "target"); err == nil {
				t.Fatal("unsafe operation lock accepted")
			}
		})
	}
}

func TestCheckpointOperationsCancellationDoesNotReleaseTheOwner(t *testing.T) {
	o := Operations{Root: filepath.Join(t.TempDir(), "operations")}
	lease, err := o.Lock(t.Context(), "target")
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Millisecond)
	defer cancel()
	if _, err := o.Lock(ctx, "target"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("contended lease: %v", err)
	}
	if err := lease.Retire(); err != nil {
		t.Fatal(err)
	}
	if err := lease.CheckIdle(); err != nil {
		t.Fatal(err)
	}
	if err := lease.Invalidate(); err != nil {
		t.Fatal(err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	next, err := o.Lock(t.Context(), "target")
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	record, err := next.read()
	if err != nil || record == nil || !record.Retired {
		t.Fatalf("cancellation lost the retirement marker: %#v %v", record, err)
	}
	if _, err := o.Lock(ctx, "other"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expired admission: %v", err)
	}
}

func TestCheckpointOperationsRejectCorruptPersistedJournals(t *testing.T) {
	for _, scenario := range []string{"oversized", "json", "unknown-stage", "version", "target", "missing-receipt", "invalid-request", "retired-stage", "retired-target", "retired-version"} {
		t.Run(scenario, func(t *testing.T) {
			r, request, native, _ := recoveryHarness(t)
			if _, err := r.Restore(t.Context(), request, uuid.NewString()); err != nil {
				t.Fatal(err)
			}
			lease, err := r.Operations.Lock(t.Context(), request.Target)
			if err != nil {
				t.Fatal(err)
			}
			defer lease.Close()
			data, err := os.ReadFile(lease.path)
			if err != nil {
				t.Fatal(err)
			}
			var record restoreRecord
			if err := json.Unmarshal(data, &record); err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "unknown-stage":
				record.Stage = "unexpected"
			case "version":
				record.Version++
			case "target":
				record.Request.Target = "another"
				record.Request.PlatformEnv["BOXLITE_BOX_ID"] = "another"
			case "missing-receipt":
				record.AcceptedID = ""
			case "invalid-request":
				record.Request.Mode = "unexpected"
			case "retired-stage":
				record.Retired = true
			case "retired-target":
				record.Retired = true
				record.Stage = "invalidated"
				record.Request.Target = "another"
			case "retired-version":
				record.Retired = true
				record.Stage = "invalidated"
				record.Version++
			}
			data, err = json.Marshal(record)
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "oversized" {
				data = []byte(strings.Repeat(" ", 64*1024+1))
			}
			if scenario == "json" {
				data = []byte("{")
			}
			if err := os.WriteFile(lease.path, data, 0600); err != nil {
				t.Fatal(err)
			}
			if err := lease.CheckIdle(); err == nil {
				t.Fatal("corrupt journal admitted a lifecycle operation")
			}
			if err := lease.Invalidate(); err == nil {
				t.Fatal("corrupt journal was silently replaced")
			}
			after, err := os.ReadFile(lease.path)
			if err != nil || string(after) != string(data) {
				t.Fatalf("rejection changed the journal: %v", err)
			}
			if native.removes != 1 || native.imports != 1 {
				t.Fatal("journal validation repeated native effects")
			}
		})
	}
}
