// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package storage

import (
	"context"
	"encoding/json"
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

const (
	testGCSArchive = "gs://snapshots/box-snapshots/org-1/snap-1.boxlite"
	testGCSObject  = "snapshots/box-snapshots/org-1/snap-1.boxlite"
)

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
	source := filepath.Join(dir, "snap-1.boxlite")
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
	assertNoFile(t, restored+".part")

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
	assertNoFile(t, restored+".part")
}
