//go:build boxlite_dev

// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/boxlite-ai/runner/pkg/api/dto"
)

// The control plane resubmits a migration step until one reports success, so a
// runner that finished the work and died before reporting gets the same job
// again. These two tests cover the branches that make the second delivery
// converge instead of failing forever — the only place in the runner that knows
// what a boxlite "already there" / "already gone" looks like.
//
// SkipStart keeps the box at Configured: the branches under test read and remove
// persisted records, so no VM has to boot.

// ImportBox must adopt a box that is already present. The archive path handed in
// does not exist, which is what proves the short-circuit: falling through to
// runtime.Import would fail on the missing file.
func TestIntegrationImportBoxAdoptsBoxAlreadyPresentOnReplay(t *testing.T) {
	ctx := context.Background()

	client, err := NewClient(ctx, ClientConfig{HomeDir: t.TempDir()})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	const boxId = "import-replay-box"
	if _, _, err := client.Create(ctx, dto.CreateBoxDTO{
		Id:           boxId,
		Image:        "alpine:latest",
		OsUser:       "root",
		CpuQuota:     1,
		MemoryQuota:  1,
		StorageQuota: 1,
		SkipStart:    boolPtr(true),
	}); err != nil {
		// Pulling the image / preparing the box is an infrastructure
		// prerequisite, not the behavior under test.
		t.Skipf("create could not complete (infrastructure prerequisite): %v", err)
	}

	missingArchive := filepath.Join(t.TempDir(), "never-written.boxlite")
	if err := client.ImportBox(ctx, boxId, missingArchive); err != nil {
		t.Fatalf("replayed ImportBox must adopt the present box without reading the archive, got: %v", err)
	}

	// The adopted box is still addressable, so the runner can go on serving it.
	if _, err := client.runtime.GetInfo(ctx, boxId); err != nil {
		t.Fatalf("box %s must survive a replayed import: %v", boxId, err)
	}
}
