// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package checkpoint

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
)

type restoreBoundaryBackend struct {
	*recoveryNative
	lookupErr   error
	removeErr   error
	importID    *string
	afterImport func() error
}

func (n restoreBoundaryBackend) Lookup(ctx context.Context, target string) (*NativeBox, error) {
	if n.lookupErr != nil {
		return nil, n.lookupErr
	}
	return n.recoveryNative.Lookup(ctx, target)
}

func (n restoreBoundaryBackend) Remove(ctx context.Context, id string) error {
	if n.removeErr != nil {
		return n.removeErr
	}
	return n.recoveryNative.Remove(ctx, id)
}

func (n restoreBoundaryBackend) Import(ctx context.Context, path, target string) (string, error) {
	if n.importID != nil {
		return *n.importID, nil
	}
	id, err := n.recoveryNative.Import(ctx, path, target)
	if n.afterImport != nil {
		if err := n.afterImport(); err != nil {
			return "", err
		}
	}
	return id, err
}

func TestCheckpointRestoreRejectsInvalidAdmissionWithoutNativeEffects(t *testing.T) {
	for _, scenario := range []string{"operation-id", "sequence", "sequence-overflow", "target", "long-target", "mode", "owner", "size", "pin", "attempt", "backend", "payload-size", "cancelled"} {
		t.Run(scenario, func(t *testing.T) {
			r, request, native, _ := recoveryHarness(t)
			attempt := uuid.NewString()
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			switch scenario {
			case "operation-id":
				request.OperationID = "not-an-id"
			case "sequence":
				request.Sequence = 0
			case "sequence-overflow":
				request.Sequence = 1 << 53
			case "target":
				request.Target = ""
			case "long-target":
				request.Target = strings.Repeat("t", 129)
				request.PlatformEnv["BOXLITE_BOX_ID"] = request.Target
			case "mode":
				request.Mode = "replace"
			case "owner":
				request.Archive.ExportJobID = "../job"
			case "size":
				request.Archive.SizeBytes = 0
			case "pin":
				request.Archive.PinnedImage = "alpine:latest"
			case "attempt":
				attempt = "../attempt"
			case "backend":
				r.Backend = nil
			case "payload-size":
				request.PlatformEnv["BOXLITE_TRACE_CARRIER"] = strings.Repeat("x", 65*1024)
			case "cancelled":
				cancel()
			}
			if _, err := r.Restore(ctx, request, attempt); err == nil {
				t.Fatal("invalid replacement was admitted")
			}
			if native.prepares != 0 || native.removes != 0 || native.imports != 0 {
				t.Fatal("rejected admission changed native state")
			}
		})
	}
}

func TestCheckpointRestoreReportsNativeBoundaryFailures(t *testing.T) {
	for _, scenario := range []string{"lookup", "missing-target", "remove", "empty-id", "reused-id", "missing-store", "receipt-write"} {
		t.Run(scenario, func(t *testing.T) {
			r, request, native, _ := recoveryHarness(t)
			backend := restoreBoundaryBackend{recoveryNative: native}
			switch scenario {
			case "lookup":
				backend.lookupErr = errors.New("lookup unavailable")
			case "missing-target":
				native.current = nil
			case "remove":
				backend.removeErr = errors.New("removal unavailable")
			case "empty-id":
				empty := ""
				backend.importID = &empty
			case "reused-id":
				id := native.current.ID
				backend.importID = &id
			case "missing-store":
				r.Store = nil
			case "receipt-write":
				lease, err := r.Operations.Lock(t.Context(), request.Target)
				if err != nil {
					t.Fatal(err)
				}
				path := lease.path
				if err := lease.Close(); err != nil {
					t.Fatal(err)
				}
				backend.afterImport = func() error {
					if err := os.Remove(path); err != nil {
						return err
					}
					return os.Mkdir(path, 0700)
				}
			}
			r.Backend = backend
			_, err := r.Restore(t.Context(), request, uuid.NewString())
			if err == nil {
				t.Fatal("native failure was reported as successful")
			}
			if scenario == "receipt-write" {
				if !strings.Contains(err.Error(), "completion recording failed") || native.current == nil || native.imports != 1 {
					t.Fatalf("accepted native result was lost: %v", err)
				}
			} else if scenario != "empty-id" && scenario != "reused-id" && native.imports != 0 {
				t.Fatal("a rejected preflight reached native import")
			}
		})
	}
}

func TestCheckpointRestoreRejectsChangedTargetsAndAcceptedReceipts(t *testing.T) {
	for _, accepted := range []bool{false, true} {
		t.Run(map[bool]string{false: "pending", true: "accepted"}[accepted], func(t *testing.T) {
			r, request, native, _ := recoveryHarness(t)
			if !accepted {
				native.preflightErr = errors.New("preflight unavailable")
			}
			_, err := r.Restore(t.Context(), request, uuid.NewString())
			if accepted && err != nil {
				t.Fatal(err)
			}
			if !accepted && err == nil {
				t.Fatal("failed preflight succeeded")
			}
			native.current = &NativeBox{ID: uuid.NewString(), State: "stopped"}
			native.preflightErr = nil
			removes, imports, prepares := native.removes, native.imports, native.prepares
			if _, err := r.Restore(t.Context(), request, uuid.NewString()); err == nil {
				t.Fatal("replacement adopted another native Box")
			}
			if native.removes != removes || native.imports != imports || native.prepares != prepares {
				t.Fatal("changed target reached destructive work")
			}
		})
	}
}
