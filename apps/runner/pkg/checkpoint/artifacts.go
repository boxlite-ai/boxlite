// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

// Package checkpoint owns exported archives until their upload is acknowledged.
package checkpoint

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/boxlite-ai/runner/pkg/storage"
	"github.com/google/uuid"
	"golang.org/x/sys/unix"
)

// Reference identifies one capture, independently of subsequent source changes.
type Reference struct {
	CheckpointID string `json:"checkpointId"`
	ExportJobID  string `json:"exportJobId"`
	SourceBoxID  string `json:"sourceBoxId"`
	ArcPath      string `json:"arcPath"`
}

type Artifact struct {
	Reference
	SizeBytes   int64  `json:"sizeBytes"`
	SHA256      string `json:"sha256"`
	PinnedImage string `json:"pinnedImage"`
}

type Artifacts struct{ Root string }

// Capture writes into its private directory and returns the actual archive
// path and the digest-pinned image associated with the source disk.
type Capture func(context.Context, string) (archive, pinnedImage string, err error)

func (a Artifacts) Export(ctx context.Context, ref Reference, capture Capture) (Artifact, error) {
	directory, unlock, err := a.lock(ctx, ref)
	if err != nil {
		return Artifact{}, err
	}
	defer unlock()
	if record, err := a.read(directory, ref); err == nil {
		return record, a.verify(directory, record)
	} else if !errors.Is(err, os.ErrNotExist) {
		return Artifact{}, err
	}
	// An intent survives incomplete exports and acknowledged uploads. A late
	// redelivery must never capture the source's newer disk under this identity.
	intent, err := os.OpenFile(filepath.Join(directory, "capture.json"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if errors.Is(err, os.ErrExist) {
		return Artifact{}, fmt.Errorf("checkpoint export %s has no reusable archive; refusing to recapture the source", ref.ExportJobID)
	}
	if err != nil {
		return Artifact{}, err
	}
	err = json.NewEncoder(intent).Encode(ref)
	if err == nil {
		err = intent.Sync()
	}
	err = errors.Join(err, intent.Close())
	if err != nil {
		return Artifact{}, err
	}
	if err := syncDirectory(directory); err != nil {
		return Artifact{}, err
	}
	stage, err := os.MkdirTemp(directory, ".export-")
	if err != nil {
		return Artifact{}, err
	}
	defer os.RemoveAll(stage)
	archive, image, err := capture(ctx, stage)
	if err != nil {
		return Artifact{}, err
	}
	if !pinnedImage(image) {
		return Artifact{}, fmt.Errorf("checkpoint capture did not supply a SHA-256 pinned image")
	}
	relative, err := filepath.Rel(stage, archive)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) || filepath.Dir(relative) != "." {
		return Artifact{}, fmt.Errorf("checkpoint exporter returned an archive outside its private directory")
	}
	file, err := regularFile(archive)
	if err != nil {
		return Artifact{}, err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return Artifact{}, err
	}
	if err := file.Close(); err != nil {
		return Artifact{}, err
	}
	if err := os.Chmod(archive, 0400); err != nil {
		return Artifact{}, err
	}
	if err := os.Rename(archive, filepath.Join(directory, "archive.boxlite")); err != nil {
		return Artifact{}, err
	}
	size, digest, err := checksum(filepath.Join(directory, "archive.boxlite"))
	if err != nil {
		return Artifact{}, err
	}
	record := Artifact{Reference: ref, SizeBytes: size, SHA256: digest, PinnedImage: image}
	if size == 0 {
		return Artifact{}, fmt.Errorf("checkpoint archive is empty")
	}
	if err := writeRecord(directory, record); err != nil {
		return Artifact{}, err
	}
	return record, nil
}

// Upload leaves the file in place even on success. Only an acknowledged
// terminal upload job permits cleanup, so a lost API callback can be replayed.
func (a Artifacts) Upload(ctx context.Context, expected Artifact, store storage.ArchiveStore) (Artifact, error) {
	directory, unlock, err := a.lock(ctx, expected.Reference)
	if err != nil {
		return Artifact{}, err
	}
	defer unlock()
	record, err := a.read(directory, expected.Reference)
	if err != nil {
		return Artifact{}, err
	}
	if record != expected {
		return Artifact{}, fmt.Errorf("checkpoint upload metadata does not match its captured artifact")
	}
	if err := a.verify(directory, record); err != nil {
		return Artifact{}, err
	}
	if store == nil {
		return Artifact{}, fmt.Errorf("checkpoint archive store is not configured")
	}
	if err := store.Upload(ctx, record.ArcPath, filepath.Join(directory, "archive.boxlite")); err != nil {
		return Artifact{}, err
	}
	return record, nil
}

func (a Artifacts) Acknowledge(ctx context.Context, expected Artifact) error {
	directory, unlock, err := a.lock(ctx, expected.Reference)
	if err != nil {
		return err
	}
	defer unlock()
	record, err := a.read(directory, expected.Reference)
	if err != nil {
		return err
	}
	if record != expected {
		return fmt.Errorf("checkpoint cleanup metadata does not match its captured artifact")
	}
	if err := os.Remove(filepath.Join(directory, "archive.boxlite")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// Keep the small record and intent as a replay tombstone. Removing the
	// directory would permit an old export job to capture the source again.
	return syncDirectory(directory)
}

func validateReference(ref Reference) error {
	for _, id := range []string{ref.CheckpointID, ref.ExportJobID} {
		parsed, err := uuid.Parse(id)
		if err != nil || parsed.String() != id {
			return fmt.Errorf("checkpoint and export job IDs must be canonical UUIDs")
		}
	}
	if ref.SourceBoxID == "" || ref.ArcPath == "" {
		return fmt.Errorf("checkpoint source and archive location are required")
	}
	return nil
}

func (a Artifacts) lock(ctx context.Context, ref Reference) (string, func(), error) {
	if err := validateReference(ref); err != nil {
		return "", nil, err
	}
	if a.Root == "" {
		return "", nil, fmt.Errorf("checkpoint work directory is required")
	}
	directory := filepath.Join(a.Root, ref.CheckpointID, ref.ExportJobID)
	locks := filepath.Join(a.Root, ".locks")
	if err := os.MkdirAll(a.Root, 0700); err != nil {
		return "", nil, err
	}
	if err := privateDirectory(locks); err != nil {
		return "", nil, err
	}
	file, err := os.OpenFile(filepath.Join(locks, ref.CheckpointID+"-"+ref.ExportJobID), os.O_CREATE|os.O_RDWR|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0600)
	if err != nil {
		return "", nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		return "", nil, fmt.Errorf("checkpoint lock must be a regular file")
	}
	unlock := func() { _ = unix.Flock(int(file.Fd()), unix.LOCK_UN); _ = file.Close() }
	for {
		if err := ctx.Err(); err != nil {
			file.Close()
			return "", nil, err
		}
		err = unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			break
		}
		if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) {
			file.Close()
			return "", nil, err
		}
		select {
		case <-ctx.Done():
			file.Close()
			return "", nil, ctx.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
	for _, path := range []string{filepath.Dir(directory), directory} {
		if err := privateDirectory(path); err != nil {
			unlock()
			return "", nil, err
		}
	}
	return directory, unlock, nil
}

func privateDirectory(path string) error {
	if err := os.Mkdir(path, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return fmt.Errorf("checkpoint directory must be private and cannot be a symlink")
	}
	return nil
}

func (a Artifacts) read(directory string, expected Reference) (Artifact, error) {
	file, err := regularFile(filepath.Join(directory, "artifact.json"))
	if err != nil {
		return Artifact{}, err
	}
	defer file.Close()
	bytes, err := io.ReadAll(io.LimitReader(file, 64*1024+1))
	if err != nil {
		return Artifact{}, err
	}
	if len(bytes) > 64*1024 {
		return Artifact{}, fmt.Errorf("checkpoint artifact metadata is too large")
	}
	var record Artifact
	if err := json.Unmarshal(bytes, &record); err != nil {
		return Artifact{}, err
	}
	if record.Reference != expected || record.SizeBytes <= 0 || !sha256Digest(record.SHA256) || !pinnedImage(record.PinnedImage) {
		return Artifact{}, fmt.Errorf("checkpoint artifact metadata does not match its owner or format")
	}
	return record, nil
}

func (a Artifacts) verify(directory string, record Artifact) error {
	size, digest, err := checksum(filepath.Join(directory, "archive.boxlite"))
	if err != nil {
		return err
	}
	if size != record.SizeBytes || digest != record.SHA256 {
		return fmt.Errorf("checkpoint artifact size or checksum mismatch")
	}
	return nil
}

func regularFile(path string) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		return nil, fmt.Errorf("checkpoint member must be a regular file: %w", errors.Join(err, errors.New("invalid member")))
	}
	return file, nil
}

func checksum(path string) (int64, string, error) {
	file, err := regularFile(path)
	if err != nil {
		return 0, "", err
	}
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	return size, hex.EncodeToString(hash.Sum(nil)), err
}

func writeRecord(directory string, record Artifact) error {
	file, err := os.CreateTemp(directory, ".artifact-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	err = json.NewEncoder(file).Encode(record)
	if err == nil {
		err = file.Sync()
	}
	err = errors.Join(err, file.Close())
	if err != nil {
		return err
	}
	if err := os.Rename(file.Name(), filepath.Join(directory, "artifact.json")); err != nil {
		return err
	}
	return syncDirectory(directory)
}

func syncDirectory(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}

func sha256Digest(digest string) bool {
	decoded, err := hex.DecodeString(digest)
	return err == nil && len(decoded) == sha256.Size && digest == strings.ToLower(digest)
}

func pinnedImage(image string) bool {
	name, digest, found := strings.Cut(image, "@sha256:")
	return found && name != "" && sha256Digest(digest)
}
