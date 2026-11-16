// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package checkpoint

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

func reference() Reference {
	return Reference{CheckpointID: uuid.NewString(), ExportJobID: uuid.NewString(), SourceBoxID: "source", ArcPath: "gs://archives/checkpoints/" + uuid.NewString() + ".boxlite"}
}

func TestCheckpointArtifactDurabilityFailurePreventsCapture(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("directory permission failure requires an unprivileged user")
	}
	for _, nested := range []bool{false, true} {
		t.Run(fmt.Sprintf("nested=%v", nested), func(t *testing.T) {
			parent := t.TempDir()
			if err := os.Chmod(parent, 0300); err != nil {
				t.Fatal(err)
			}
			defer os.Chmod(parent, 0700)
			root := parent
			if nested {
				root = filepath.Join(parent, "new", "archives")
			}
			captured := false
			_, err := (Artifacts{Root: root}).Export(context.Background(), reference(), func(ctx context.Context, path string) (string, string, error) {
				captured = true
				return captureBytes("must not capture before parent durability")(ctx, path)
			})
			if captured {
				t.Fatal("capture ran before the parent directory could be synced")
			}
			if !errors.Is(err, os.ErrPermission) {
				t.Fatalf("expected parent sync permission error, got %v", err)
			}
		})
	}
}

func captureBytes(data string) Capture {
	return func(_ context.Context, directory string) (string, string, error) {
		path := filepath.Join(directory, "source.boxlite")
		return path, "registry:5000/app@sha256:" + strings.Repeat("a", 64), os.WriteFile(path, []byte(data), 0600)
	}
}

func mustExport(t *testing.T, artifacts Artifacts, ref Reference, capture Capture) Artifact {
	t.Helper()
	record, err := artifacts.Export(context.Background(), ref, capture)
	if err != nil {
		t.Fatal(err)
	}
	return record
}

func noCapture(t *testing.T) Capture {
	t.Helper()
	return func(context.Context, string) (string, string, error) {
		t.Error("source must not be captured again")
		return "", "", errors.New("unexpected capture")
	}
}

type transferStore struct {
	mu       sync.Mutex
	uploaded map[string][]byte
	fail     bool
	entered  chan struct{}
	resume   chan struct{}
}

func (s *transferStore) Upload(ctx context.Context, key, path string) error {
	if s.entered != nil {
		close(s.entered)
		select {
		case <-s.resume:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fail {
		return errors.New("upload unavailable")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if s.uploaded == nil {
		s.uploaded = map[string][]byte{}
	}
	s.uploaded[key] = data
	return nil
}
func (*transferStore) Download(context.Context, string, string) error {
	return errors.New("download not expected")
}
func (*transferStore) Remove(context.Context, string) error { return errors.New("remove not expected") }

func TestCheckpointArtifactReplayDoesNotReadTheSource(t *testing.T) {
	artifacts := Artifacts{Root: t.TempDir()}
	ref := reference()
	first := mustExport(t, artifacts, ref, captureBytes(t.Name()))
	second := mustExport(t, Artifacts{Root: artifacts.Root}, ref, noCapture(t))
	if second != first {
		t.Fatalf("replay changed the artifact: %#v != %#v", second, first)
	}
	path := filepath.Join(artifacts.Root, ref.CheckpointID, ref.ExportJobID, "archive.boxlite")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0400 || info.Size() != first.SizeBytes {
		t.Fatalf("archive mode/size: %v", info)
	}
	size, digest, err := checksum(path)
	if err != nil || size != first.SizeBytes || digest != first.SHA256 {
		t.Fatalf("persisted digest does not describe the actual archive: %v", err)
	}
}

func TestCheckpointArtifactRetainedThroughUploadRetryUntilAcknowledgment(t *testing.T) {
	artifacts := Artifacts{Root: t.TempDir()}
	record := mustExport(t, artifacts, reference(), captureBytes(t.Name()))
	store := &transferStore{fail: true}
	if _, err := artifacts.Upload(context.Background(), record, store); err == nil {
		t.Fatal("failed upload succeeded")
	}
	store.fail = false
	if _, err := artifacts.Upload(context.Background(), record, store); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(artifacts.Root, record.CheckpointID, record.ExportJobID, "archive.boxlite")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("upload removed unacknowledged artifact: %v", err)
	}
	if string(store.uploaded[record.ArcPath]) != string(before) {
		t.Fatal("upload did not use the captured file")
	}
	if err := artifacts.Acknowledge(context.Background(), record); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("acknowledged archive still exists: %v", err)
	}
	if err := artifacts.Acknowledge(context.Background(), record); err != nil {
		t.Fatal(err)
	}
	if _, err := artifacts.Export(context.Background(), record.Reference, noCapture(t)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("late export must not recapture: %v", err)
	}
}

func TestCheckpointArtifactUploadDoesNotBlockAnotherCaptureOfTheSameSource(t *testing.T) {
	artifacts := Artifacts{Root: t.TempDir()}
	first := mustExport(t, artifacts, reference(), captureBytes(t.Name()+"/first"))
	store := &transferStore{entered: make(chan struct{}), resume: make(chan struct{})}
	upload := make(chan error, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go func() { _, err := artifacts.Upload(ctx, first, store); upload <- err }()
	select {
	case <-store.entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	defer close(store.resume)
	// The first upload remains blocked while another export publishes. Both
	// requests refer to the same source, but never share a local archive path.
	second := mustExport(t, artifacts, reference(), captureBytes(t.Name()+"/second"))
	if first.SHA256 == second.SHA256 {
		t.Fatal("different captures have the same artifact")
	}
	store.resume <- struct{}{}
	if err := <-upload; err != nil {
		t.Fatal(err)
	}
	if err := artifacts.Acknowledge(ctx, first); err != nil {
		t.Fatal(err)
	}
	if _, err := artifacts.Upload(ctx, second, &transferStore{}); err != nil {
		t.Fatalf("first cleanup damaged second capture: %v", err)
	}
}

func TestCheckpointArtifactConcurrentRedeliveryCapturesOnlyOnce(t *testing.T) {
	artifacts := Artifacts{Root: t.TempDir()}
	ref := reference()
	entered, resume := make(chan struct{}), make(chan struct{})
	var count atomic.Int32
	capture := func(ctx context.Context, path string) (string, string, error) {
		if count.Add(1) != 1 {
			return "", "", errors.New("duplicate capture")
		}
		close(entered)
		<-resume
		return captureBytes(t.Name())(ctx, path)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	results := make(chan error, 2)
	go func() { _, err := artifacts.Export(ctx, ref, capture); results <- err }()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	go func() { _, err := (Artifacts{Root: artifacts.Root}).Export(ctx, ref, capture); results <- err }()
	close(resume)
	for range 2 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if count.Load() != 1 {
		t.Fatalf("captured %d times", count.Load())
	}
}

func TestCheckpointArtifactMissingOrCorruptFilesNeverRecaptureOrUpload(t *testing.T) {
	for _, damage := range []string{"missing", "changed", "metadata", "symlink"} {
		t.Run(damage, func(t *testing.T) {
			artifacts := Artifacts{Root: t.TempDir()}
			record := mustExport(t, artifacts, reference(), captureBytes(t.Name()))
			directory := filepath.Join(artifacts.Root, record.CheckpointID, record.ExportJobID)
			path := filepath.Join(directory, "archive.boxlite")
			switch damage {
			case "missing":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			case "changed":
				if err := os.Chmod(path, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte("changed"), 0600); err != nil {
					t.Fatal(err)
				}
			case "metadata":
				if err := os.WriteFile(filepath.Join(directory, "artifact.json"), []byte("{"), 0600); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(filepath.Join(directory, "artifact.json"), path); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := artifacts.Export(context.Background(), record.Reference, noCapture(t)); err == nil {
				t.Fatal("damaged replay succeeded")
			}
			store := &transferStore{}
			if _, err := artifacts.Upload(context.Background(), record, store); err == nil {
				t.Fatal("damaged artifact uploaded")
			}
			if len(store.uploaded) != 0 {
				t.Fatal("upload store was called for damaged archive")
			}
		})
	}
}

func TestCheckpointArtifactFailedCaptureIsNotRepeatedAfterRestart(t *testing.T) {
	artifacts := Artifacts{Root: t.TempDir()}
	ref := reference()
	_, err := artifacts.Export(context.Background(), ref, func(_ context.Context, path string) (string, string, error) {
		if err := os.WriteFile(filepath.Join(path, "partial.boxlite"), []byte("partial"), 0600); err != nil {
			t.Fatal(err)
		}
		return "", "", errors.New("capture failed after writing")
	})
	if err == nil {
		t.Fatal("capture unexpectedly succeeded")
	}
	entries, err := os.ReadDir(filepath.Join(artifacts.Root, ref.CheckpointID, ref.ExportJobID))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "capture.json" {
		t.Fatalf("partial export leaked: %v", entries)
	}
	if _, err := (Artifacts{Root: artifacts.Root}).Export(context.Background(), ref, noCapture(t)); err == nil {
		t.Fatal("failed capture was repeated")
	}
}

func TestCheckpointArtifactRejectsInvalidOwnersBeforeCreatingWork(t *testing.T) {
	for _, id := range []string{"../escape", "", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "a/b"} {
		t.Run(fmt.Sprintf("%q", id), func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "untouched")
			ref := reference()
			ref.CheckpointID = id
			if _, err := (Artifacts{Root: root}).Export(context.Background(), ref, noCapture(t)); err == nil {
				t.Fatal("invalid owner accepted")
			}
			if _, err := os.Stat(root); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("invalid request created work directory: %v", err)
			}
		})
	}
}

func TestCheckpointPinsOnlyTheSourcesRecordedBuild(t *testing.T) {
	digest := "sha256:" + strings.Repeat("a", 64)
	for _, reference := range []string{"registry:5000/org/app:tag", "registry:5000/org/app@" + digest} {
		pinned, err := PinImage(reference, digest)
		if err != nil || pinned != "registry:5000/org/app@"+digest {
			t.Fatalf("image pin: %q, %v", pinned, err)
		}
	}
	if _, err := PinImage("registry:5000/org/app:tag", ""); err == nil {
		t.Fatal("mutable tag with no disk build record was accepted")
	}
	if _, err := PinImage("registry:5000/org/app:tag", "sha256:abc"); err == nil {
		t.Fatal("invalid recorded digest was accepted")
	}
}

func TestCheckpointArtifactRefusesUploadOwnershipChanges(t *testing.T) {
	artifacts := Artifacts{Root: t.TempDir()}
	record := mustExport(t, artifacts, reference(), captureBytes(t.Name()))
	record.ArcPath = "gs://other/override"
	store := &transferStore{}
	if _, err := artifacts.Upload(context.Background(), record, store); err == nil {
		t.Fatal("object key was changed")
	}
	if err := artifacts.Acknowledge(context.Background(), record); err == nil {
		t.Fatal("wrong-owner cleanup succeeded")
	}
	if len(store.uploaded) != 0 {
		t.Fatal("wrong owner reached upload store")
	}
}
