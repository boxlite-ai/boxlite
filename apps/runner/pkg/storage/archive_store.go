// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package storage

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// s3URIScheme prefixes an arcPath that names its own bucket.
const s3URIScheme = "s3://"

// ArchiveStore is the object-store leg of a box migration: the exporting runner
// uploads the .boxlite archive, the importing runner downloads it, and whichever
// runner finishes or rolls the migration back deletes it.
//
// The arcPath addressing every object is chosen by the control plane and travels
// in the job payload, so a redelivered job acts on the object its first delivery
// did — and on the object the control plane recorded for the box.
type ArchiveStore interface {
	Upload(ctx context.Context, arcPath, localPath string) error
	Download(ctx context.Context, arcPath, localPath string) error
	Remove(ctx context.Context, arcPath string) error
}

// S3ArchiveStore keeps migration archives as objects in a single S3 bucket.
type S3ArchiveStore struct {
	client *minio.Client
	bucket string
}

// S3ArchiveStoreConfig carries the runner's own S3 credentials — the archive is
// infrastructure state moved between two runners, not organization-scoped user
// data, so it does not go through the control plane's push-access grant.
type S3ArchiveStoreConfig struct {
	EndpointUrl     string
	Region          string
	AccessKeyId     string
	SecretAccessKey string
	Bucket          string
}

func NewS3ArchiveStore(cfg S3ArchiveStoreConfig) (*S3ArchiveStore, error) {
	if cfg.Bucket == "" {
		return nil, fmt.Errorf("migration archive bucket is required (AWS_DEFAULT_BUCKET)")
	}

	endpoint, secure, err := s3Endpoint(cfg.EndpointUrl, cfg.Region)
	if err != nil {
		return nil, err
	}

	client, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKeyId, cfg.SecretAccessKey, ""),
		Secure: secure,
		Region: cfg.Region,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create object store client for %s: %w", endpoint, err)
	}

	return &S3ArchiveStore{client: client, bucket: cfg.Bucket}, nil
}

// s3Endpoint resolves the host[:port] minio-go expects, plus whether to dial
// TLS. An explicit AWS_ENDPOINT_URL wins (minio in development, a VPC endpoint
// in production); with none set the regional AWS host is derived.
func s3Endpoint(endpointUrl, region string) (string, bool, error) {
	if endpointUrl == "" {
		if region == "" {
			return "", false, fmt.Errorf("either AWS_ENDPOINT_URL or AWS_REGION must be set to reach the object store")
		}
		return fmt.Sprintf("s3.%s.amazonaws.com", region), true, nil
	}

	parsed, err := url.Parse(endpointUrl)
	if err != nil {
		return "", false, fmt.Errorf("invalid AWS_ENDPOINT_URL %q: %w", endpointUrl, err)
	}
	if parsed.Host == "" {
		return "", false, fmt.Errorf("invalid AWS_ENDPOINT_URL %q: no host", endpointUrl)
	}

	return parsed.Host, parsed.Scheme == "https", nil
}

func (s *S3ArchiveStore) Upload(ctx context.Context, arcPath, localPath string) error {
	bucket, key, err := s.resolveArcPath(arcPath)
	if err != nil {
		return err
	}

	if _, err := s.client.FPutObject(ctx, bucket, key, localPath, minio.PutObjectOptions{}); err != nil {
		return fmt.Errorf("failed to upload %s to s3://%s/%s: %w", localPath, bucket, key, err)
	}
	return nil
}

func (s *S3ArchiveStore) Download(ctx context.Context, arcPath, localPath string) error {
	bucket, key, err := s.resolveArcPath(arcPath)
	if err != nil {
		return err
	}

	if err := s.client.FGetObject(ctx, bucket, key, localPath, minio.GetObjectOptions{}); err != nil {
		return fmt.Errorf("failed to download s3://%s/%s to %s: %w", bucket, key, localPath, err)
	}
	return nil
}

// Remove deletes the archive object. S3 deletes are idempotent — removing a key
// that is already gone reports success — which is what a redelivered rollback or
// finish job needs to converge.
func (s *S3ArchiveStore) Remove(ctx context.Context, arcPath string) error {
	bucket, key, err := s.resolveArcPath(arcPath)
	if err != nil {
		return err
	}

	if err := s.client.RemoveObject(ctx, bucket, key, minio.RemoveObjectOptions{}); err != nil {
		return fmt.Errorf("failed to remove s3://%s/%s: %w", bucket, key, err)
	}
	return nil
}

// resolveArcPath splits the control plane's arcPath into the bucket and key to
// act on. A bare key goes to the bucket this runner is configured with; an
// s3://<bucket>/<key> URI lets the control plane name a bucket the runner does
// not have configured, which is what lets one migration span two runners whose
// own buckets differ.
func (s *S3ArchiveStore) resolveArcPath(arcPath string) (string, string, error) {
	if arcPath == "" {
		return "", "", fmt.Errorf("arcPath must not be empty")
	}
	if !strings.HasPrefix(arcPath, s3URIScheme) {
		return s.bucket, arcPath, nil
	}

	bucket, key, found := strings.Cut(strings.TrimPrefix(arcPath, s3URIScheme), "/")
	if !found || bucket == "" || key == "" {
		return "", "", fmt.Errorf("invalid arcPath %q: want s3://<bucket>/<key>", arcPath)
	}
	return bucket, key, nil
}
