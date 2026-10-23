// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package storage

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
)

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

// The control plane picks the backend per archive through the URI scheme, so a
// gs:// snapshot on a runner that also serves S3 migrations must reach Cloud
// Storage, and a missing backend must fail the one job that needs it.
func TestSchemeArchiveStoreRoutesByScheme(t *testing.T) {
	gcsStore, s3Store := &recordingStore{}, &recordingStore{}
	store := &SchemeArchiveStore{GCS: gcsStore, S3: s3Store}

	for _, arcPath := range []string{"gs://snapshots/org/snap.boxlite", "s3://archives/box.boxlite", "box-migrations/box.boxlite"} {
		if err := store.Remove(context.Background(), arcPath); err != nil {
			t.Fatalf("Remove(%q) error = %v", arcPath, err)
		}
	}

	if want := []string{"gs://snapshots/org/snap.boxlite"}; !slices.Equal(gcsStore.removed, want) {
		t.Fatalf("Cloud Storage received %v, want %v", gcsStore.removed, want)
	}
	if want := []string{"s3://archives/box.boxlite", "box-migrations/box.boxlite"}; !slices.Equal(s3Store.removed, want) {
		t.Fatalf("S3 received %v, want %v", s3Store.removed, want)
	}

	onlyGCS := &SchemeArchiveStore{GCS: gcsStore}
	if err := onlyGCS.Remove(context.Background(), "box-migrations/box.boxlite"); err == nil ||
		!strings.Contains(err.Error(), "AWS_DEFAULT_BUCKET") {
		t.Fatalf("Remove on a runner without S3 = %v, want the configuration hint", err)
	}
}

func TestParseGCSURI(t *testing.T) {
	bucket, key, err := parseGCSURI("gs://snapshots/box-snapshots/org-1/snap-1.boxlite")
	if err != nil || bucket != "snapshots" || key != "box-snapshots/org-1/snap-1.boxlite" {
		t.Fatalf("parseGCSURI = (%q, %q, %v)", bucket, key, err)
	}

	for _, arcPath := range []string{"", "snapshots/key", "gs://", "gs://bucket", "gs://bucket/", "gs:///key"} {
		if _, _, err := parseGCSURI(arcPath); err == nil {
			t.Fatalf("parseGCSURI(%q) accepted an invalid URI", arcPath)
		}
	}
}

// Close commits whatever a Cloud Storage writer was given, so an upload whose
// local read fails has to be cancelled rather than closed, or it leaves a
// truncated archive at the URI the control plane recorded.
func TestGCSArchiveStoreUploadLeavesNothingWhenTheReadFails(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"bucket":"snapshots","name":"snap-1.boxlite"}`)
	}))
	defer server.Close()
	t.Setenv("STORAGE_EMULATOR_HOST", server.URL)

	// Reading a directory fails the copy, as a disk error partway through would.
	err := (&GCSArchiveStore{}).Upload(context.Background(), "gs://snapshots/snap-1.boxlite", t.TempDir())

	if err == nil {
		t.Fatal("Upload of an unreadable file succeeded")
	}
	if n := requests.Load(); n != 0 {
		t.Fatalf("a failed upload reached Cloud Storage %d time(s), want none", n)
	}
}

type recordingStore struct {
	removed []string
}

func (r *recordingStore) Upload(context.Context, string, string) error   { return nil }
func (r *recordingStore) Download(context.Context, string, string) error { return nil }
func (r *recordingStore) Remove(_ context.Context, arcPath string) error {
	r.removed = append(r.removed, arcPath)
	return nil
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
