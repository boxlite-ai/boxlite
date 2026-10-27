// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"

	gcs "cloud.google.com/go/storage"
)

// gcsURIScheme prefixes an arcPath that names a Cloud Storage object.
const gcsURIScheme = "gs://"

// GCSArchiveStore keeps archives as Cloud Storage objects addressed by full
// gs://<bucket>/<key> URIs. It has no bucket of its own: the control plane
// names one in every arcPath it hands out.
//
// Credentials come from Application Default Credentials — on a GCE runner the
// attached service account, the one gcsfuse already mounts volumes with, which
// the GCP stack grants object access on the snapshot bucket. The
// client is made on first use, so a runner that never sees a gs:// archive
// never goes looking for credentials, and one that failed to find them tries
// again on the next job rather than for the rest of its life.
type GCSArchiveStore struct {
	mu     sync.Mutex
	client *gcs.Client
}

func (s *GCSArchiveStore) object(ctx context.Context, arcPath string) (*gcs.ObjectHandle, error) {
	bucket, key, err := parseGCSURI(arcPath)
	if err != nil {
		return nil, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.client == nil {
		client, err := gcs.NewClient(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to create Cloud Storage client: %w", err)
		}
		s.client = client
	}
	return s.client.Bucket(bucket).Object(key), nil
}

// Upload writes the archive under arcPath. Cloud Storage makes the object
// visible only once Close succeeds, and Close commits whatever was written,
// so a copy that fails cancels the upload instead: no partial archive is left
// behind.
func (s *GCSArchiveStore) Upload(ctx context.Context, arcPath, localPath string) error {
	obj, err := s.object(ctx, arcPath)
	if err != nil {
		return err
	}

	file, err := os.Open(localPath)
	if err != nil {
		return fmt.Errorf("failed to open %s: %w", localPath, err)
	}
	defer file.Close()

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	writer := obj.NewWriter(ctx)
	if _, err := io.Copy(writer, file); err != nil {
		cancel()
		_ = writer.Close()
		return fmt.Errorf("failed to upload %s to %s: %w", localPath, arcPath, err)
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("failed to upload %s to %s: %w", localPath, arcPath, err)
	}
	return nil
}

// Download copies the archive to localPath. It writes beside the destination
// and renames into place, so a broken download never leaves a truncated
// archive where the caller looks for a whole one.
func (s *GCSArchiveStore) Download(ctx context.Context, arcPath, localPath string) error {
	obj, err := s.object(ctx, arcPath)
	if err != nil {
		return err
	}

	reader, err := obj.NewReader(ctx)
	if err != nil {
		return fmt.Errorf("failed to read %s: %w", arcPath, err)
	}
	defer reader.Close()

	partial := localPath + ".part"
	file, err := os.Create(partial)
	if err != nil {
		return fmt.Errorf("failed to create %s: %w", partial, err)
	}
	_, copyErr := io.Copy(file, reader)
	closeErr := file.Close()
	if err := errors.Join(copyErr, closeErr); err != nil {
		_ = os.Remove(partial)
		return fmt.Errorf("failed to download %s to %s: %w", arcPath, localPath, err)
	}
	if err := os.Rename(partial, localPath); err != nil {
		_ = os.Remove(partial)
		return fmt.Errorf("failed to move %s into place: %w", partial, err)
	}
	return nil
}

// Remove deletes the archive; one that is already gone counts as removed, which
// is what a redelivered job needs to converge.
func (s *GCSArchiveStore) Remove(ctx context.Context, arcPath string) error {
	obj, err := s.object(ctx, arcPath)
	if err != nil {
		return err
	}
	if err := obj.Delete(ctx); err != nil && !errors.Is(err, gcs.ErrObjectNotExist) {
		return fmt.Errorf("failed to remove %s: %w", arcPath, err)
	}
	return nil
}

// parseGCSURI splits gs://<bucket>/<key> into its bucket and key.
func parseGCSURI(arcPath string) (string, string, error) {
	bucket, key, found := strings.Cut(strings.TrimPrefix(arcPath, gcsURIScheme), "/")
	if !strings.HasPrefix(arcPath, gcsURIScheme) || !found || bucket == "" || key == "" {
		return "", "", fmt.Errorf("invalid arcPath %q: want gs://<bucket>/<key>", arcPath)
	}
	return bucket, key, nil
}
