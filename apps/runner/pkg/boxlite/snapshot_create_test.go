//go:build boxlite_dev

// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/boxlite-ai/runner/pkg/api/dto"
)

func snapshotCreateDTO(id string) dto.CreateBoxDTO {
	return dto.CreateBoxDTO{Id: id, Image: "ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0",
		OsUser: "boxlite", CpuQuota: 1, MemoryQuota: 1, StorageQuota: 2, OutboundEnabled: boolPtr(false)}
}

func TestSnapshotCreateInvalidArchiveNeverStartsBox(t *testing.T) {
	ctx := context.Background()
	client, err := NewClient(ctx, ClientConfig{HomeDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	request := snapshotCreateDTO("invalid-snapshot-child")
	request.SnapshotArchivePath = filepath.Join(t.TempDir(), "invalid.boxlite")
	if err := os.WriteFile(request.SnapshotArchivePath, []byte("bad archive"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := client.Create(ctx, request); err == nil || !strings.Contains(err.Error(), "initialize snapshot disk") {
		t.Fatalf("Create must reject the archive before boot: %v", err)
	}
	info, err := client.runtime.GetInfo(ctx, request.Id)
	if err != nil {
		t.Fatal(err)
	}
	if !info.StartedAt.IsZero() || string(info.State) != "configured" {
		t.Fatalf("invalid archive booted box: %+v", info)
	}
}

func TestSnapshotCreateCopiesDiskAndReplayPreservesChildWrites(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	client, err := NewClient(ctx, ClientConfig{HomeDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	source := snapshotCreateDTO("snapshot-source")
	if _, _, err := client.Create(ctx, source); err != nil {
		t.Fatalf("create source: %v", err)
	}
	t.Cleanup(func() { _ = client.runtime.ForceRemove(context.Background(), source.Id) })
	writeMarker := func(id, value string) {
		box, err := client.runtime.Get(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		defer box.Close()
		result, err := box.Exec(ctx, "sudo", "/bin/sh", "-c", "printf '"+value+"' > /root/snapshot-marker && sync")
		if err != nil || result.ExitCode != 0 {
			t.Fatalf("write marker: %v, %+v", err, result)
		}
	}
	writeMarker(source.Id, "snapshot-content")
	if err := client.Stop(ctx, source.Id, false); err != nil {
		t.Fatal(err)
	}
	archive, err := client.ExportBox(ctx, source.Id, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	child := snapshotCreateDTO("snapshot-child")
	child.SnapshotArchivePath = archive
	if _, _, err := client.Create(ctx, child); err != nil {
		t.Fatalf("create child: %v", err)
	}
	t.Cleanup(func() { _ = client.runtime.ForceRemove(context.Background(), child.Id) })
	readMarker := func(want string) {
		box, err := client.runtime.Get(ctx, child.Id)
		if err != nil {
			t.Fatal(err)
		}
		defer box.Close()
		result, err := box.Exec(ctx, "sudo", "/bin/cat", "/root/snapshot-marker")
		if err != nil || result.ExitCode != 0 || result.Stdout != want {
			t.Fatalf("marker = %+v, error %v; want %q", result, err, want)
		}
	}
	readMarker("snapshot-content")
	writeMarker(child.Id, "child-writes")
	if err := os.Remove(archive); err != nil {
		t.Fatal(err)
	}
	if _, _, err := client.Create(ctx, child); err != nil {
		t.Fatalf("replay child: %v", err)
	}
	readMarker("child-writes")
}
