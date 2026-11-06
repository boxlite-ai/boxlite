// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package checkpoint

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/boxlite-ai/runner/pkg/storage"
	"github.com/google/uuid"
)

// DownloadedArchive owns one import attempt's source file. Keep it until native
// preparation finishes; each attempt has a distinct private staging directory.
type DownloadedArchive struct {
	Path      string
	Artifact  Artifact
	directory string
}

func (d *DownloadedArchive) Close() error { return os.RemoveAll(d.directory) }

// Download isolates transfer staging and checks the expected length. The shared
// native checkpoint preparer subsequently verifies SHA-256, archive members,
// disks, configuration and pinned startup dependencies before target removal.
func (a Artifacts) Download(ctx context.Context, record Artifact, importJobID string, store storage.ArchiveStore) (_ *DownloadedArchive, err error) {
	if err := validateReference(record.Reference); err != nil {
		return nil, err
	}
	id, err := uuid.Parse(importJobID)
	if err != nil || id.String() != importJobID || record.SizeBytes <= 0 || !sha256Digest(record.SHA256) || !pinnedImage(record.PinnedImage) {
		return nil, fmt.Errorf("invalid checkpoint import identity or archive metadata")
	}
	if a.Root == "" || store == nil {
		return nil, fmt.Errorf("checkpoint download requires a work directory and archive store")
	}
	if scheme, ok := store.(*storage.SchemeArchiveStore); ok {
		if err := scheme.Check(record.ArcPath); err != nil {
			return nil, err
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(a.Root, 0700); err != nil {
		return nil, err
	}
	root := filepath.Join(a.Root, record.CheckpointID)
	if err := privateDirectory(root); err != nil {
		return nil, err
	}
	directory, err := os.MkdirTemp(root, ".download-"+importJobID+"-")
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			err = errors.Join(err, os.RemoveAll(directory))
		}
	}()
	path := filepath.Join(directory, "archive.boxlite")
	if err := store.Download(ctx, record.ArcPath, path); err != nil {
		return nil, err
	}
	file, err := regularFile(path)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	closeErr := file.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if info.Size() != record.SizeBytes {
		return nil, fmt.Errorf("downloaded checkpoint length does not match its recorded size")
	}
	if err := os.Chmod(path, 0400); err != nil {
		return nil, err
	}
	return &DownloadedArchive{Path: path, Artifact: record, directory: directory}, nil
}
