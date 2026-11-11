// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package checkpoint

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/boxlite-ai/runner/pkg/storage"
	"github.com/google/uuid"
)

type downloadStore struct {
	*transferStore
	calls      atomic.Int32
	damage     string
	linkTarget string
}

func (s *downloadStore) Download(_ context.Context, key, path string) error {
	s.calls.Add(1)
	s.mu.Lock()
	data, found := s.uploaded[key]
	data = append([]byte(nil), data...)
	s.mu.Unlock()
	if !found {
		return errors.New("object missing")
	}
	if s.damage == "symlink" {
		return os.Symlink(s.linkTarget, path)
	}
	if s.damage == "corrupt" {
		data[len(data)-1] ^= 1
	} else if s.damage != "" {
		data = data[:len(data)-1]
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		return err
	}
	if s.damage == "failed" {
		return errors.New("download failed after partial write")
	}
	return nil
}

func uploaded(t *testing.T) (Artifacts, Artifact, *downloadStore) {
	t.Helper()
	artifacts := Artifacts{Root: t.TempDir()}
	record := mustExport(t, artifacts, reference(), captureBytes(t.Name()))
	store := &downloadStore{transferStore: &transferStore{}}
	if _, err := artifacts.Upload(context.Background(), record, store); err != nil {
		t.Fatal(err)
	}
	return artifacts, record, store
}

func TestCheckpointDownloadUsesPrivateIndependentImportAttempts(t *testing.T) {
	artifacts, record, store := uploaded(t)
	jobID := uuid.NewString()
	first, err := artifacts.Download(context.Background(), record, jobID, store)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := artifacts.Download(context.Background(), record, jobID, store)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if first.Path == second.Path {
		t.Fatal("duplicate import deliveries shared a staging file")
	}
	info, err := os.Stat(first.Path)
	if err != nil || info.Mode().Perm() != 0400 {
		t.Fatalf("downloaded archive permissions: %v %v", info, err)
	}
	_, digest, err := checksum(first.Path)
	if err != nil || digest != record.SHA256 {
		t.Fatalf("download did not preserve uploaded bytes: %s %v", digest, err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(second.Path); err != nil {
		t.Fatalf("first cleanup removed second attempt: %v", err)
	}
	if _, err := artifacts.Export(context.Background(), record.Reference, noCapture(t)); err != nil {
		t.Fatalf("import cleanup changed retained export: %v", err)
	}
}

func TestCheckpointDownloadRemovesFailedPartialOrLinkedStaging(t *testing.T) {
	for _, damage := range []string{"failed", "short", "corrupt", "symlink"} {
		t.Run(damage, func(t *testing.T) {
			artifacts, record, store := uploaded(t)
			store.damage = damage
			store.linkTarget = filepath.Join(artifacts.Root, record.CheckpointID, record.ExportJobID, "archive.boxlite")
			if _, err := artifacts.Download(context.Background(), record, uuid.NewString(), store); err == nil {
				t.Fatal("invalid transfer succeeded")
			}
			entries, err := os.ReadDir(filepath.Join(artifacts.Root, record.CheckpointID))
			if err != nil {
				t.Fatal(err)
			}
			for _, entry := range entries {
				if strings.HasPrefix(entry.Name(), ".download-") {
					t.Fatalf("failed download left %s", entry.Name())
				}
			}
			if _, err := artifacts.Export(context.Background(), record.Reference, noCapture(t)); err != nil {
				t.Fatalf("failed download damaged retained capture: %v", err)
			}
		})
	}
}

func TestCheckpointDownloadRejectsMalformedMetadataOrCancellationBeforeTransfer(t *testing.T) {
	artifacts, record, store := uploaded(t)
	invalid := record
	invalid.SHA256 = "invalid"
	if _, err := artifacts.Download(context.Background(), invalid, uuid.NewString(), store); err == nil {
		t.Fatal("invalid checksum metadata accepted")
	}
	if _, err := artifacts.Download(context.Background(), record, "../outside", store); err == nil {
		t.Fatal("invalid import identity accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := artifacts.Download(ctx, record, uuid.NewString(), store); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled download: %v", err)
	}
	if store.calls.Load() != 0 {
		t.Fatal("invalid or canceled request reached object storage")
	}
}

func TestCheckpointDownloadRejectsUnconfiguredOrUnsafeDestinations(t *testing.T) {
	for _, scenario := range []string{"source-owner", "empty-root", "no-store", "unsupported-store", "root-file", "checkpoint-link", "public-checkpoint"} {
		t.Run(scenario, func(t *testing.T) {
			original, record, store := uploaded(t)
			retained := record.Reference
			destination := Artifacts{Root: filepath.Join(t.TempDir(), "imports")}
			var selected storage.ArchiveStore = store
			switch scenario {
			case "source-owner":
				record.SourceBoxID = ""
			case "empty-root":
				destination.Root = ""
			case "no-store":
				selected = nil
			case "unsupported-store":
				selected = &storage.SchemeArchiveStore{}
			case "root-file":
				if err := os.WriteFile(destination.Root, []byte("occupied"), 0600); err != nil {
					t.Fatal(err)
				}
			case "checkpoint-link", "public-checkpoint":
				if err := os.Mkdir(destination.Root, 0700); err != nil {
					t.Fatal(err)
				}
				path := filepath.Join(destination.Root, record.CheckpointID)
				if scenario == "checkpoint-link" {
					if err := os.Symlink(t.TempDir(), path); err != nil {
						t.Fatal(err)
					}
				} else if err := os.Mkdir(path, 0755); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := destination.Download(t.Context(), record, uuid.NewString(), selected); err == nil {
				t.Fatal("unsafe download was admitted")
			}
			if store.calls.Load() != 0 {
				t.Fatal("rejected destination reached object storage")
			}
			// Rejection may not remove or change the independently retained capture.
			if _, err := original.Export(t.Context(), retained, noCapture(t)); err != nil {
				t.Fatalf("download refusal changed captured bytes: %v", err)
			}
		})
	}
}
