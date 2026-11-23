// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package storage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func assertNoDownloadStaging(t *testing.T, destination string) {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(filepath.Dir(destination), "."+filepath.Base(destination)+"-*.part"))
	if err != nil || len(matches) != 0 {
		t.Fatalf("download staging survived: %v, %v", matches, err)
	}
}

const (
	testGCSArchive = "gs://archives/checkpoints/org-1/checkpoint-1.boxlite"
	testGCSObject  = "archives/checkpoints/org-1/checkpoint-1.boxlite"
)

type failedArchiveReader struct{ err error }

func TestSchemeArchiveStoreRejectsUnavailableSchemes(t *testing.T) {
	store := &SchemeArchiveStore{}
	for _, uri := range []string{testGCSArchive, "s3://archives/checkpoint-1.boxlite"} {
		for name, invoke := range map[string]func() error{
			"check":    func() error { return store.Check(uri) },
			"upload":   func() error { return store.Upload(context.Background(), uri, "unused") },
			"download": func() error { return store.Download(context.Background(), uri, "unused") },
			"remove":   func() error { return store.Remove(context.Background(), uri) },
		} {
			t.Run(uri+"/"+name, func(t *testing.T) {
				if err := invoke(); err == nil {
					t.Fatal("archive operation accepted an unavailable backend")
				}
			})
		}
	}
}

func TestGCSArchiveRejectsInvalidLocationsBeforeClientInitialization(t *testing.T) {
	store := &GCSArchiveStore{}
	ctx := context.Background()
	for name, invoke := range map[string]func() error{
		"upload":   func() error { return store.Upload(ctx, "gs:///missing", "unused") },
		"download": func() error { return store.Download(ctx, "gs:///missing", "unused") },
		"remove":   func() error { return store.Remove(ctx, "gs:///missing") },
	} {
		t.Run(name, func(t *testing.T) {
			if err := invoke(); err == nil || !strings.Contains(err.Error(), "invalid arcPath") {
				t.Fatalf("invalid location = %v", err)
			}
			if store.client != nil {
				t.Fatal("invalid location initialized a storage client")
			}
		})
	}
}

func TestGCSArchiveRetriesClientInitializationAfterCredentialFailure(t *testing.T) {
	t.Setenv("STORAGE_EMULATOR_HOST", "")
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", filepath.Join(t.TempDir(), "absent.json"))
	store := &GCSArchiveStore{}
	if _, err := store.object(context.Background(), testGCSArchive); err == nil || store.client != nil {
		t.Fatalf("missing credentials = %v, client initialized = %v", err, store.client != nil)
	}
	fake := newFakeGCS(t)
	fake.objects[testGCSObject] = []byte("retried archive")
	destination := filepath.Join(t.TempDir(), "archive")
	if err := store.Download(context.Background(), testGCSArchive, destination); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(destination)
	if err != nil || string(contents) != "retried archive" {
		t.Fatalf("retry = %q, %v", contents, err)
	}
}

func TestGCSArchiveLocalFailuresPreserveExistingData(t *testing.T) {
	fake := newFakeGCS(t)
	fake.objects[testGCSObject] = []byte("remote archive")
	store := &GCSArchiveStore{}
	ctx := context.Background()
	root := t.TempDir()
	if err := store.Upload(ctx, testGCSArchive, filepath.Join(root, "absent")); err == nil || !strings.Contains(err.Error(), "failed to open") {
		t.Fatalf("absent upload = %v", err)
	}
	if contents, _ := fake.object(testGCSObject); string(contents) != "remote archive" {
		t.Fatal("failed upload changed remote data")
	}
	missing := filepath.Join(root, "missing", "archive")
	if err := store.Download(ctx, testGCSArchive, missing); err == nil || !strings.Contains(err.Error(), "failed to create") {
		t.Fatalf("absent destination directory = %v", err)
	}
	destination := filepath.Join(root, "directory")
	if err := os.Mkdir(destination, 0700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(destination, "kept")
	if err := os.WriteFile(marker, []byte("existing data"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := store.Download(ctx, testGCSArchive, destination); err == nil || !strings.Contains(err.Error(), "failed to move") {
		t.Fatalf("directory collision = %v", err)
	}
	assertNoDownloadStaging(t, destination)
	if contents, err := os.ReadFile(marker); err != nil || string(contents) != "existing data" {
		t.Fatalf("existing destination changed: %q, %v", contents, err)
	}
	if err := store.Download(ctx, "gs://archives/absent", filepath.Join(root, "not-created")); err == nil || !strings.Contains(err.Error(), "failed to read") {
		t.Fatalf("missing remote object = %v", err)
	}
}

func TestGCSArchivePropagatesUploadCommitAndDeleteRefusals(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, `{"error":{"code":403,"message":"archive access denied"}}`)
	}))
	defer server.Close()
	t.Setenv("STORAGE_EMULATOR_HOST", server.URL)
	source := filepath.Join(t.TempDir(), "archive")
	if err := os.WriteFile(source, []byte("complete archive"), 0600); err != nil {
		t.Fatal(err)
	}
	store := &GCSArchiveStore{}
	if err := store.Upload(context.Background(), testGCSArchive, source); err == nil || !strings.Contains(err.Error(), "failed to upload") {
		t.Fatalf("upload commit refusal = %v", err)
	}
	if err := store.Remove(context.Background(), testGCSArchive); err == nil || !strings.Contains(err.Error(), "failed to remove") {
		t.Fatalf("delete refusal = %v", err)
	}
}

func TestGCSArchiveDownloadOwnerOnly(t *testing.T) {
	for _, existing := range []bool{false, true} {
		t.Run(fmt.Sprintf("existing-destination-%v", existing), func(t *testing.T) {
			fake := newFakeGCS(t)
			fake.objects[testGCSObject] = []byte("private disk archive")
			destination := filepath.Join(t.TempDir(), "saved.boxlite")
			if existing {
				if err := os.WriteFile(destination, []byte("old destination"), 0644); err != nil {
					t.Fatal(err)
				}
				if err := os.Chmod(destination, 0644); err != nil {
					t.Fatal(err)
				}
			}
			if err := (&GCSArchiveStore{}).Download(context.Background(), testGCSArchive, destination); err != nil {
				t.Fatal(err)
			}
			info, err := os.Stat(destination)
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm() != 0600 {
				t.Errorf("download mode = %04o, want 0600", info.Mode().Perm())
			}
			data, err := os.ReadFile(destination)
			if err != nil || string(data) != "private disk archive" {
				t.Fatalf("download = %q, %v", data, err)
			}
		})
	}
}

func (r failedArchiveReader) Read([]byte) (int, error) { return 0, r.err }

func TestGCSArchiveUploadDoesNotFinalizeAPrefixAfterReadFailure(t *testing.T) {
	fake := newFakeGCS(t)
	ctx := context.Background()
	store := &GCSArchiveStore{}
	obj, err := store.object(ctx, testGCSArchive)
	if err != nil {
		t.Fatal(err)
	}
	readErr := errors.New("archive read failed after prefix")
	reader := io.MultiReader(strings.NewReader("archive prefix"), failedArchiveReader{readErr})
	if err := uploadArchive(ctx, obj, reader); !errors.Is(err, readErr) {
		t.Fatalf("upload = %v, want reader failure", err)
	}
	if _, ok := fake.object(testGCSObject); ok {
		t.Fatal("failed reader published a partial archive")
	}
	if err := uploadArchive(ctx, obj, strings.NewReader("complete archive")); err != nil {
		t.Fatal(err)
	}
	if content, _ := fake.object(testGCSObject); string(content) != "complete archive" {
		t.Fatalf("successful control stored %q", content)
	}
}

// fakeGCS answers the Cloud Storage calls the archive store makes — multipart
// uploads, XML reads and JSON deletes — from objects it keeps in memory, keyed
// by bucket/name. truncate makes a read stop short and the resumed read find
// nothing, the way a download that loses its connection fails; resumed records
// that the client came back for the rest.
type fakeGCS struct {
	mu       sync.Mutex
	objects  map[string][]byte
	truncate bool
	resumed  bool
}

func newFakeGCS(t *testing.T) *fakeGCS {
	t.Helper()
	fake := &fakeGCS{objects: map[string][]byte{}}
	server := httptest.NewServer(http.HandlerFunc(fake.serve))
	t.Cleanup(server.Close)
	t.Setenv("STORAGE_EMULATOR_HOST", server.URL)
	return fake
}

func (f *fakeGCS) object(path string) ([]byte, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	content, ok := f.objects[path]
	return content, ok
}

func (f *fakeGCS) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()

	switch {
	case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/upload/storage/v1/b/"):
		bucket := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/upload/storage/v1/b/"), "/o")
		name, content, err := uploadedObject(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		f.objects[bucket+"/"+name] = content
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"bucket": bucket, "name": name, "size": fmt.Sprint(len(content))})
	case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/storage/v1/b/"):
		bucket, name, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/storage/v1/b/"), "/o/")
		if _, ok := f.objects[bucket+"/"+name]; !ok {
			http.Error(w, `{"error":{"code":404,"message":"Not Found"}}`, http.StatusNotFound)
			return
		}
		delete(f.objects, bucket+"/"+name)
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodGet:
		content, ok := f.objects[strings.TrimPrefix(r.URL.Path, "/")]
		if f.truncate && r.Header.Get("Range") != "" {
			f.resumed = true
			ok = false
		}
		if !ok {
			http.Error(w, "Not Found", http.StatusNotFound)
			return
		}
		if f.truncate {
			// Promise more than is sent, so the connection closes short.
			w.Header().Set("Content-Length", fmt.Sprint(len(content)+64))
		}
		_, _ = w.Write(content)
	default:
		http.Error(w, "unexpected "+r.Method+" "+r.URL.String(), http.StatusNotImplemented)
	}
}

// uploadedObject reads a multipart upload: the object's name from its JSON
// metadata part, falling back to the name parameter, then its bytes.
func uploadedObject(r *http.Request) (string, []byte, error) {
	_, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil {
		return "", nil, err
	}
	reader := multipart.NewReader(r.Body, params["boundary"])
	metadata, err := reader.NextPart()
	if err != nil {
		return "", nil, err
	}
	var attrs struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(metadata).Decode(&attrs); err != nil {
		return "", nil, err
	}
	if attrs.Name == "" {
		attrs.Name = r.URL.Query().Get("name")
	}
	media, err := reader.NextPart()
	if err != nil {
		return "", nil, err
	}
	content, err := io.ReadAll(media)
	return attrs.Name, content, err
}

func assertNoFile(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("%s exists (stat error %v), want nothing there", path, err)
	}
}

// The store against Cloud Storage's own protocol: an upload lands whole, a
// download arrives at its path with no partial file beside it, and removing
// an archive twice is as good as removing it once.
func TestGCSArchiveStoreMovesAnArchiveThroughCloudStorage(t *testing.T) {
	fake := newFakeGCS(t)
	store := &GCSArchiveStore{}
	ctx := context.Background()
	dir := t.TempDir()
	source := filepath.Join(dir, "checkpoint-1.boxlite")
	if err := os.WriteFile(source, []byte("archive bytes"), 0600); err != nil {
		t.Fatal(err)
	}

	if err := store.Upload(ctx, testGCSArchive, source); err != nil {
		t.Fatalf("Upload = %v", err)
	}
	if content, _ := fake.object(testGCSObject); string(content) != "archive bytes" {
		t.Fatalf("stored object = %q, want the archive", content)
	}

	restored := filepath.Join(dir, "restored.boxlite")
	if err := store.Download(ctx, testGCSArchive, restored); err != nil {
		t.Fatalf("Download = %v", err)
	}
	if content, err := os.ReadFile(restored); err != nil || string(content) != "archive bytes" {
		t.Fatalf("downloaded archive = %q, %v", content, err)
	}
	assertNoDownloadStaging(t, restored)

	for range 2 {
		if err := store.Remove(ctx, testGCSArchive); err != nil {
			t.Fatalf("Remove = %v, want nil even once the archive is gone", err)
		}
	}
	if _, ok := fake.object(testGCSObject); ok {
		t.Fatal("the archive is still stored after Remove")
	}
}

// A download that breaks off partway leaves nothing where the caller looks
// for a whole archive, nor the partial file it was writing.
func TestGCSArchiveStoreDownloadLeavesNothingWhenItBreaksOff(t *testing.T) {
	fake := newFakeGCS(t)
	fake.objects[testGCSObject] = []byte("archive bytes")
	fake.truncate = true
	restored := filepath.Join(t.TempDir(), "restored.boxlite")

	if err := (&GCSArchiveStore{}).Download(context.Background(), testGCSArchive, restored); err == nil {
		t.Fatal("Download of a transfer that broke off succeeded")
	}
	fake.mu.Lock()
	resumed := fake.resumed
	fake.mu.Unlock()
	if !resumed {
		t.Fatal("the transfer never broke off mid-copy, so the partial file went untested")
	}
	assertNoFile(t, restored)
	assertNoDownloadStaging(t, restored)
}
