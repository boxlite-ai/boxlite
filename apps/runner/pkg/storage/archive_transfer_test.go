// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package storage

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	gcs "cloud.google.com/go/storage"
	"google.golang.org/api/option"
)

type archiveTransport func(*http.Request) (*http.Response, error)

func (f archiveTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type blockedArchiveBody struct {
	io.ReadCloser
	ctx     context.Context
	started chan<- struct{}
	release <-chan struct{}
	once    sync.Once
}

func (b *blockedArchiveBody) Read(p []byte) (int, error) {
	b.once.Do(func() { b.started <- struct{}{} })
	select {
	case <-b.ctx.Done():
		return 0, b.ctx.Err()
	case <-b.release:
		return b.ReadCloser.Read(p)
	}
}

// Pause the real HTTP response body when Download first reads it. At that
// boundary the store must already own its staging file; no scheduling sleeps
// are needed to inspect overlapping downloads or cancel an active transfer.
func blockedDownloadStore(t *testing.T, started chan<- struct{}, release <-chan struct{}) *GCSArchiveStore {
	t.Helper()
	client, err := gcs.NewClient(context.Background(), option.WithHTTPClient(&http.Client{
		Transport: archiveTransport(func(r *http.Request) (*http.Response, error) {
			response, err := http.DefaultTransport.RoundTrip(r)
			if err == nil && r.Method == http.MethodGet && response.StatusCode == http.StatusOK {
				response.Body = &blockedArchiveBody{ReadCloser: response.Body, ctx: r.Context(), started: started, release: release}
			}
			return response, err
		}),
	}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return &GCSArchiveStore{client: client}
}

func TestGCSArchiveConcurrentDownloadsOwnSeparateStaging(t *testing.T) {
	fake := newFakeGCS(t)
	fake.objects[testGCSObject] = []byte("complete archive")
	started, release := make(chan struct{}, 2), make(chan struct{})
	store := blockedDownloadStore(t, started, release)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	destination := filepath.Join(t.TempDir(), "archive.boxlite")
	if err := os.WriteFile(destination, []byte("existing archive"), 0600); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 2)
	for range 2 {
		go func() { done <- store.Download(ctx, testGCSArchive, destination) }()
	}
	for range 2 {
		select {
		case <-started:
		case <-ctx.Done():
			t.Fatal("downloads did not reach their HTTP response bodies")
		}
	}
	staging, err := filepath.Glob(filepath.Join(filepath.Dir(destination), ".archive.boxlite-*.part"))
	if err != nil || len(staging) != 2 {
		t.Fatalf("overlapping staging files = %v, %v", staging, err)
	}
	for _, path := range staging {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("staging permissions for %s = %v, %v", path, info, err)
		}
	}
	if content, err := os.ReadFile(destination); err != nil || string(content) != "existing archive" {
		t.Fatalf("destination changed before download completion: %q, %v", content, err)
	}
	close(release)
	for range 2 {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	if content, err := os.ReadFile(destination); err != nil || string(content) != "complete archive" {
		t.Fatalf("completed destination = %q, %v", content, err)
	}
	assertNoDownloadStaging(t, destination)
}

func TestGCSArchiveCanceledDownloadPreservesDestination(t *testing.T) {
	fake := newFakeGCS(t)
	fake.objects[testGCSObject] = []byte("remote archive")
	started, release := make(chan struct{}, 1), make(chan struct{})
	store := blockedDownloadStore(t, started, release)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	destination := filepath.Join(t.TempDir(), "archive.boxlite")
	if err := os.WriteFile(destination, []byte("retained archive"), 0600); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- store.Download(ctx, testGCSArchive, destination) }()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("download did not reach its HTTP response body")
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("canceled download succeeded")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("canceled download did not finish")
	}
	if content, err := os.ReadFile(destination); err != nil || string(content) != "retained archive" {
		t.Fatalf("canceled download changed destination: %q, %v", content, err)
	}
	assertNoDownloadStaging(t, destination)
}

func TestSchemeArchiveStoreTransfersThroughBothHTTPBackends(t *testing.T) {
	gcsServer := newFakeGCS(t)
	var mu sync.Mutex
	objects := map[string][]byte{}
	s3Server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch r.Method {
		case http.MethodPut:
			content, err := io.ReadAll(r.Body)
			if err != nil {
				http.Error(w, "read failed", http.StatusBadRequest)
				return
			}
			objects[r.URL.Path] = content
			w.Header().Set("ETag", `"archive-etag"`)
		case http.MethodHead, http.MethodGet:
			content, ok := objects[r.URL.Path]
			if !ok {
				http.Error(w, "missing", http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Length", fmt.Sprint(len(content)))
			w.Header().Set("ETag", `"archive-etag"`)
			w.Header().Set("Last-Modified", time.Unix(0, 0).UTC().Format(http.TimeFormat))
			if r.Method == http.MethodGet {
				_, _ = w.Write(content)
			}
		case http.MethodDelete:
			delete(objects, r.URL.Path)
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "unexpected method", http.StatusNotImplemented)
		}
	}))
	defer s3Server.Close()
	s3, err := NewS3ArchiveStore(S3ArchiveStoreConfig{EndpointUrl: s3Server.URL, Region: "us-east-1", Bucket: "archives"})
	if err != nil {
		t.Fatal(err)
	}
	store := &SchemeArchiveStore{GCS: &GCSArchiveStore{}, S3: s3}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	source := filepath.Join(t.TempDir(), "source.boxlite")
	if err := os.WriteFile(source, []byte("archive bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, location := range []string{testGCSArchive, "s3://archives/checkpoint.boxlite", "bare-key.boxlite"} {
		t.Run(location, func(t *testing.T) {
			if err := store.Upload(ctx, location, source); err != nil {
				t.Fatal(err)
			}
			if strings.HasPrefix(location, gcsURIScheme) {
				if content, ok := gcsServer.object(testGCSObject); !ok || string(content) != "archive bytes" {
					t.Fatalf("upload did not reach GCS: %q, present=%v", content, ok)
				}
			} else {
				key := strings.TrimPrefix(location, "s3://archives/")
				mu.Lock()
				content := string(objects["/archives/"+key])
				mu.Unlock()
				if content != "archive bytes" {
					t.Fatalf("upload did not reach the addressed S3 key: %q", content)
				}
			}
			destination := filepath.Join(t.TempDir(), "download.boxlite")
			if err := store.Download(ctx, location, destination); err != nil {
				t.Fatal(err)
			}
			if content, err := os.ReadFile(destination); err != nil || string(content) != "archive bytes" {
				t.Fatalf("downloaded bytes = %q, %v", content, err)
			}
			for range 2 {
				if err := store.Remove(ctx, location); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
	if _, ok := gcsServer.object(testGCSObject); ok {
		t.Fatal("GCS object survived removal")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(objects) != 0 {
		t.Fatalf("S3 objects survived removal: %v", objects)
	}
}

func TestSchemeArchiveStoreRejectsInvalidLocationsBeforeEffects(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		http.Error(w, "unexpected request", http.StatusBadRequest)
	}))
	defer server.Close()
	t.Setenv("STORAGE_EMULATOR_HOST", server.URL)
	s3, err := NewS3ArchiveStore(S3ArchiveStoreConfig{EndpointUrl: server.URL, Region: "us-east-1", Bucket: "archives"})
	if err != nil {
		t.Fatal(err)
	}
	gcs := &GCSArchiveStore{}
	store := &SchemeArchiveStore{GCS: gcs, S3: s3}
	destination := filepath.Join(t.TempDir(), "unused")
	for _, location := range []string{"", "gs://", "gs:///key", "gs://archives/", "s3://archives", "s3:///key", "https://example.invalid/key", "az://archives/key"} {
		for name, invoke := range map[string]func() error{
			"check":    func() error { return store.Check(location) },
			"upload":   func() error { return store.Upload(context.Background(), location, destination) },
			"download": func() error { return store.Download(context.Background(), location, destination) },
			"remove":   func() error { return store.Remove(context.Background(), location) },
		} {
			if err := invoke(); err == nil {
				t.Fatalf("%s accepted invalid location %q", name, location)
			}
		}
	}
	if requests.Load() != 0 || gcs.client != nil {
		t.Fatal("invalid locations reached a backend")
	}
	if entries, _ := os.ReadDir(filepath.Dir(destination)); len(entries) != 0 {
		t.Fatalf("invalid locations created files: %v", entries)
	}
}
