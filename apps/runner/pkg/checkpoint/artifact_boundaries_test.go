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

	"golang.org/x/sys/unix"
)

func TestCheckpointArtifactCancelledWaiterPreservesCaptureOwnership(t *testing.T) {
	artifacts, ref := Artifacts{Root: t.TempDir()}, reference()
	started, release := make(chan struct{}), make(chan struct{}, 1)
	t.Cleanup(func() { close(release) })
	done := make(chan error, 1)
	go func() {
		_, err := artifacts.Export(t.Context(), ref, func(ctx context.Context, stage string) (string, string, error) {
			close(started)
			<-release
			return captureBytes("original capture")(ctx, stage)
		})
		done <- err
	}()
	select {
	case <-started:
	case err := <-done:
		t.Fatalf("capture failed before admission: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("capture did not acquire ownership")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Millisecond)
	defer cancel()
	if _, err := artifacts.Export(ctx, ref, noCapture(t)); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("contended capture ignored cancellation: %v", err)
	}
	release <- struct{}{}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled waiter blocked the capture owner")
	}
	if _, err := artifacts.Export(t.Context(), ref, noCapture(t)); err != nil {
		t.Fatal(err)
	}
}

func TestCheckpointArtifactRejectsInvalidExporterOutputs(t *testing.T) {
	for _, scenario := range []string{"unpinned", "outside", "nested", "directory", "missing", "linked", "empty", "blocked-archive", "blocked-record"} {
		t.Run(scenario, func(t *testing.T) {
			artifacts := Artifacts{Root: t.TempDir()}
			ref := reference()
			_, err := artifacts.Export(t.Context(), ref, func(ctx context.Context, stage string) (string, string, error) {
				path, image, err := captureBytes("captured disk")(ctx, stage)
				if err != nil {
					return "", "", err
				}
				switch scenario {
				case "unpinned":
					image = "alpine:latest"
				case "outside":
					path = filepath.Join(filepath.Dir(stage), "outside.boxlite")
					if err := os.WriteFile(path, []byte("outside"), 0600); err != nil {
						t.Fatal(err)
					}
				case "nested":
					path = filepath.Join(stage, "sub", "archive.boxlite")
					if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(path, []byte("nested"), 0600); err != nil {
						t.Fatal(err)
					}
				case "directory":
					path = stage
				case "missing":
					if err := os.Remove(path); err != nil {
						t.Fatal(err)
					}
				case "linked":
					linked := filepath.Join(stage, "link.boxlite")
					if err := os.Symlink(path, linked); err != nil {
						t.Fatal(err)
					}
					path = linked
				case "empty":
					if err := os.Truncate(path, 0); err != nil {
						t.Fatal(err)
					}
				case "blocked-archive", "blocked-record":
					member := "archive.boxlite"
					if scenario == "blocked-record" {
						member = "artifact.json"
					}
					if err := os.MkdirAll(filepath.Join(filepath.Dir(stage), member, "child"), 0700); err != nil {
						t.Fatal(err)
					}
				}
				return path, image, nil
			})
			if err == nil {
				t.Fatal("invalid capture was published")
			}
			if _, err := artifacts.Export(t.Context(), ref, noCapture(t)); err == nil {
				t.Fatal("invalid export was recaptured")
			}
			entries, err := os.ReadDir(filepath.Join(artifacts.Root, ref.CheckpointID, ref.ExportJobID))
			if err != nil {
				t.Fatal(err)
			}
			for _, entry := range entries {
				if strings.HasPrefix(entry.Name(), ".export-") || strings.HasPrefix(entry.Name(), ".artifact-") {
					t.Fatalf("failed export leaked staging: %s", entry.Name())
				}
			}
		})
	}
}

func TestCheckpointArtifactRejectsUnsafeWorkDirectoriesAndLocks(t *testing.T) {
	for _, scenario := range []string{"empty", "root-file", "lock-symlink", "lock-fifo", "checkpoint-link", "public-checkpoint"} {
		t.Run(scenario, func(t *testing.T) {
			root, ref := t.TempDir(), reference()
			locks := filepath.Join(root, ".locks")
			if err := os.Mkdir(locks, 0700); err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "empty":
				root = ""
			case "root-file":
				root = filepath.Join(root, "file")
				if err := os.WriteFile(root, []byte("occupied"), 0600); err != nil {
					t.Fatal(err)
				}
			case "lock-symlink":
				if err := os.Symlink(filepath.Join(root, "other"), filepath.Join(locks, ref.CheckpointID+"-"+ref.ExportJobID)); err != nil {
					t.Fatal(err)
				}
			case "lock-fifo":
				if err := unix.Mkfifo(filepath.Join(locks, ref.CheckpointID+"-"+ref.ExportJobID), 0600); err != nil {
					t.Fatal(err)
				}
			case "checkpoint-link":
				if err := os.Symlink(t.TempDir(), filepath.Join(root, ref.CheckpointID)); err != nil {
					t.Fatal(err)
				}
			case "public-checkpoint":
				if err := os.Mkdir(filepath.Join(root, ref.CheckpointID), 0755); err != nil {
					t.Fatal(err)
				}
			}
			artifacts := Artifacts{Root: root}
			if _, err := artifacts.Export(t.Context(), ref, noCapture(t)); err == nil {
				t.Fatal("unsafe capture directory accepted")
			}
			if _, err := artifacts.Upload(t.Context(), Artifact{Reference: ref}, &transferStore{}); err == nil {
				t.Fatal("unsafe upload directory accepted")
			}
			if err := artifacts.Acknowledge(t.Context(), Artifact{Reference: ref}); err == nil {
				t.Fatal("unsafe cleanup directory accepted")
			}
		})
	}
	artifacts := Artifacts{Root: filepath.Join(t.TempDir(), "nested", "new", "root")}
	record := mustExport(t, artifacts, reference(), captureBytes("durable nested capture"))
	if _, err := artifacts.Upload(t.Context(), record, &transferStore{}); err != nil {
		t.Fatal(err)
	}
}

func TestCheckpointArtifactMetadataAndAcknowledgmentBoundaries(t *testing.T) {
	for _, scenario := range []string{"oversized-record", "nonregular-record", "wrong-size", "no-store", "blocked-cleanup"} {
		t.Run(scenario, func(t *testing.T) {
			artifacts := Artifacts{Root: t.TempDir()}
			record := mustExport(t, artifacts, reference(), captureBytes("captured bytes"))
			directory := filepath.Join(artifacts.Root, record.CheckpointID, record.ExportJobID)
			metadata := filepath.Join(directory, "artifact.json")
			switch scenario {
			case "oversized-record":
				if err := os.WriteFile(metadata, []byte(strings.Repeat(" ", 64*1024+1)), 0600); err != nil {
					t.Fatal(err)
				}
			case "nonregular-record":
				if err := os.Remove(metadata); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(metadata, 0700); err != nil {
					t.Fatal(err)
				}
			case "wrong-size":
				record.SizeBytes++
			case "no-store":
				if _, err := artifacts.Upload(t.Context(), record, nil); err == nil {
					t.Fatal("upload accepted an absent store")
				}
				return
			case "blocked-cleanup":
				path := filepath.Join(directory, "archive.boxlite")
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if err := os.MkdirAll(filepath.Join(path, "child"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			store := &transferStore{}
			if _, err := artifacts.Upload(t.Context(), record, store); err == nil {
				t.Fatal("invalid artifact reached upload")
			}
			if err := artifacts.Acknowledge(t.Context(), record); err == nil {
				t.Fatal("invalid artifact was acknowledged")
			}
			if len(store.uploaded) != 0 {
				t.Fatal("invalid artifact reached object storage")
			}
		})
	}
	// The metadata is written by Export; corrupt only a typed field afterward.
	artifacts := Artifacts{Root: t.TempDir()}
	record := mustExport(t, artifacts, reference(), captureBytes("captured"))
	directory := filepath.Join(artifacts.Root, record.CheckpointID, record.ExportJobID)
	bad := record
	bad.PinnedImage = "alpine:latest"
	data, err := json.Marshal(bad)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "artifact.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := artifacts.Export(t.Context(), record.Reference, noCapture(t)); err == nil {
		t.Fatal("unpinned persisted metadata was accepted")
	}
}
