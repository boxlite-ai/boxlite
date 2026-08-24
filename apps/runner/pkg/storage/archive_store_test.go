// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package storage

import "testing"

// The runner reaches minio in development over plain HTTP and S3 in production
// over TLS, and minio-go wants a bare host — not a URL — plus a separate secure
// flag. Handing it the configured URL verbatim makes every request fail with an
// unparseable-endpoint error, so the split is what this covers.
func TestS3EndpointResolution(t *testing.T) {
	tests := []struct {
		name        string
		endpointUrl string
		region      string
		wantHost    string
		wantSecure  bool
		wantErr     bool
	}{
		{
			name:       "no endpoint falls back to the regional AWS host over TLS",
			region:     "eu-central-1",
			wantHost:   "s3.eu-central-1.amazonaws.com",
			wantSecure: true,
		},
		{
			name:        "local minio keeps its port and stays plaintext",
			endpointUrl: "http://localhost:9000",
			region:      "us-east-1",
			wantHost:    "localhost:9000",
			wantSecure:  false,
		},
		{
			name:        "https endpoint dials TLS",
			endpointUrl: "https://s3.us-east-1.amazonaws.com",
			region:      "us-east-1",
			wantHost:    "s3.us-east-1.amazonaws.com",
			wantSecure:  true,
		},
		{
			name:        "an endpoint without a scheme has no host to dial",
			endpointUrl: "localhost:9000",
			region:      "us-east-1",
			wantErr:     true,
		},
		{
			name:    "neither endpoint nor region leaves nothing to resolve",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			host, secure, err := s3Endpoint(tt.endpointUrl, tt.region)

			if tt.wantErr {
				if err == nil {
					t.Fatalf("s3Endpoint(%q, %q) = (%q, %v, nil), want an error", tt.endpointUrl, tt.region, host, secure)
				}
				return
			}
			if err != nil {
				t.Fatalf("s3Endpoint(%q, %q) error = %v", tt.endpointUrl, tt.region, err)
			}
			if host != tt.wantHost || secure != tt.wantSecure {
				t.Fatalf("s3Endpoint(%q, %q) = (%q, %v), want (%q, %v)", tt.endpointUrl, tt.region, host, secure, tt.wantHost, tt.wantSecure)
			}
		})
	}
}

// The control plane owns the arcPath, so the runner has to accept both forms it
// can send: a bare key destined for the runner's own bucket, and a full s3 URI
// naming a bucket this runner was never configured with.
func TestResolveArcPath(t *testing.T) {
	store := &S3ArchiveStore{bucket: "runner-default"}

	tests := []struct {
		name       string
		arcPath    string
		wantBucket string
		wantKey    string
		wantErr    bool
	}{
		{
			name:       "bare key lands in the configured bucket",
			arcPath:    "migrate/box-1/job-1.boxlite",
			wantBucket: "runner-default",
			wantKey:    "migrate/box-1/job-1.boxlite",
		},
		{
			name:       "s3 uri overrides the configured bucket",
			arcPath:    "s3://migration-archives/migrate/box-1/job-1.boxlite",
			wantBucket: "migration-archives",
			wantKey:    "migrate/box-1/job-1.boxlite",
		},
		{name: "bucket without a key", arcPath: "s3://migration-archives", wantErr: true},
		{name: "bucket with an empty key", arcPath: "s3://migration-archives/", wantErr: true},
		{name: "uri without a bucket", arcPath: "s3:///migrate/box-1.boxlite", wantErr: true},
		{name: "empty arcPath", arcPath: "", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			bucket, key, err := store.resolveArcPath(tt.arcPath)

			if tt.wantErr {
				if err == nil {
					t.Fatalf("resolveArcPath(%q) = (%q, %q, nil), want an error", tt.arcPath, bucket, key)
				}
				return
			}
			if err != nil {
				t.Fatalf("resolveArcPath(%q) error = %v", tt.arcPath, err)
			}
			if bucket != tt.wantBucket || key != tt.wantKey {
				t.Fatalf("resolveArcPath(%q) = (%q, %q), want (%q, %q)", tt.arcPath, bucket, key, tt.wantBucket, tt.wantKey)
			}
		})
	}
}

// A runner with no bucket configured must say so at construction, not hand back
// a client that fails on the first migration job with an opaque S3 error.
func TestNewS3ArchiveStoreRequiresBucket(t *testing.T) {
	store, err := NewS3ArchiveStore(S3ArchiveStoreConfig{
		EndpointUrl: "http://localhost:9000",
		Region:      "us-east-1",
	})

	if err == nil {
		t.Fatalf("NewS3ArchiveStore without a bucket = %v, want an error", store)
	}
}
