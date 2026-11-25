//go:build boxlite_dev && boxlite_integration

// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/boxlite-ai/runner/pkg/api/dto"
)

// Replay adopts the existing box only after validating the legacy archive.
func TestIntegrationImportBoxAdoptsBoxAlreadyPresentOnReplay(t *testing.T) {
	ctx := context.Background()

	client, err := NewClient(ctx, ClientConfig{HomeDir: t.TempDir()})
	if err != nil {
		t.Fatalf("start replay runtime: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	const boxId = "import-replay-box"
	if _, _, err := client.Create(ctx, dto.CreateBoxDTO{
		Id:              boxId,
		Image:           "alpine:latest",
		OsUser:          "root",
		CpuQuota:        cpuQuota(1),
		MemoryQuota:     1,
		StorageQuota:    1,
		OutboundEnabled: boolPtr(true),
		Entrypoint:      []string{"/bin/sh", "-c", "sleep 60"},
	}); err != nil {
		t.Fatalf("prepare replay target: %v", err)
	}
	t.Cleanup(func() {
		if err := client.runtime.ForceRemove(ctx, boxId); err != nil {
			t.Errorf("remove replay target: %v", err)
		}
	})
	if err := client.Stop(ctx, boxId, false); err != nil {
		t.Fatalf("stop replay target: %v", err)
	}

	before, err := client.runtime.GetInfo(ctx, boxId)
	if err != nil {
		t.Fatal(err)
	}
	archive, err := client.ExportBox(ctx, boxId, t.TempDir())
	if err != nil {
		t.Fatalf("export legacy archive: %v", err)
	}
	if err := client.ImportBox(ctx, boxId, archive); err != nil {
		t.Fatalf("replay with a legacy archive: %v", err)
	}
	missingArchive := filepath.Join(t.TempDir(), "never-written.boxlite")
	if err := client.ImportBox(ctx, boxId, missingArchive); err == nil {
		t.Fatal("replay accepted an archive it could not validate")
	}

	after, err := client.runtime.GetInfo(ctx, boxId)
	if err != nil || after.ID != before.ID {
		t.Fatalf("replay must preserve the existing box: %+v, %v", after, err)
	}
}
