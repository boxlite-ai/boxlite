// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package checkpoint

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestCheckpointJournalReadersRejectCorruptionWithoutLosingTheRecord(t *testing.T) {
	r, request, _, _ := recoveryHarness(t)
	if _, err := r.Restore(t.Context(), request, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	lease, err := r.Operations.Lock(t.Context(), request.Target)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	original, err := os.ReadFile(lease.path)
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []string{"malformed", "oversized", "version", "stage", "retired"} {
		t.Run(scenario, func(t *testing.T) {
			var record restoreRecord
			if err := json.Unmarshal(original, &record); err != nil {
				t.Fatal(err)
			}
			data := original
			switch scenario {
			case "malformed":
				data = []byte("{")
			case "oversized":
				data = append(append([]byte(nil), original...), []byte(strings.Repeat(" ", 64*1024))...)
			case "version":
				record.Version = 99
			case "stage":
				record.Stage = "unknown"
			case "retired":
				record.Retired = true
			}
			if scenario != "malformed" && scenario != "oversized" {
				data, err = json.Marshal(record)
				if err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(lease.path, data, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := r.Operations.Resolve(request.Target); err == nil {
				t.Fatal("corrupt identity was resolved")
			}
			if _, err := r.Operations.Bindings(); err == nil {
				t.Fatal("corrupt journal reached inventory")
			}
			if _, err := lease.NativeTargets(); err == nil {
				t.Fatal("corrupt cleanup targets accepted")
			}
			if _, err := lease.UnpublishedCandidate(); err == nil {
				t.Fatal("corrupt candidate accepted")
			}
			if err := lease.ClearPublished(); err == nil {
				t.Fatal("corrupt mapping was cleared")
			}
			if err := lease.Retire(); err == nil {
				t.Fatal("corrupt operation was retired")
			}
			retained, err := os.ReadFile(lease.path)
			if err != nil || string(retained) != string(data) {
				t.Fatal("failed read rewrote the journal")
			}
		})
	}
}

func TestCheckpointInventoryRejectsUnreadableEntriesAndInvalidPatterns(t *testing.T) {
	operations := Operations{Root: t.TempDir()}
	if err := os.Mkdir(filepath.Join(operations.Root, "entry.json"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := operations.Bindings(); err == nil {
		t.Fatal("directory accepted as a journal")
	}
	if _, err := (Operations{Root: "["}).Bindings(); !errors.Is(err, filepath.ErrBadPattern) {
		t.Fatalf("invalid journal pattern: %v", err)
	}
}

func TestCheckpointUnpublishedCandidateRemainsAvailableForExplicitCleanup(t *testing.T) {
	r, request, native, _ := recoveryHarness(t)
	native.importErr = errors.New("import failed")
	if _, err := r.Restore(t.Context(), request, uuid.NewString()); err == nil {
		t.Fatal("expected import failure")
	}
	lease, err := r.Operations.Lock(t.Context(), request.Target)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	candidate, err := lease.UnpublishedCandidate()
	if err != nil || candidate != "checkpoint-"+request.OperationID {
		t.Fatalf("lost unpublished candidate: %q %v", candidate, err)
	}
	if err := lease.ClearPublished(); err != nil {
		t.Fatal(err)
	}
}
