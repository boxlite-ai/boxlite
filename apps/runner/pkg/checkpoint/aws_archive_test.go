// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package checkpoint

import (
	"context"
	"crypto/md5"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/boxlite-ai/runner/pkg/storage"
	"github.com/google/uuid"
)

func TestCheckpointS3ArchiveRoundTripChecksumAndExactDeletion(t *testing.T) {
	var mu sync.Mutex
	objects := make(map[string][]byte)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if !strings.Contains(r.Header.Get("Authorization"), "Credential=TEMP_ACCESS_KEY/") ||
			r.Header.Get("X-Amz-Security-Token") != "temporary-session" {
			t.Error("temporary S3 credentials were omitted")
			w.WriteHeader(http.StatusForbidden)
			return
		}
		switch r.Method {
		case http.MethodPut:
			var body io.Reader = r.Body
			if r.Header.Get("X-Amz-Decoded-Content-Length") != "" {
				body = httputil.NewChunkedReader(r.Body)
			}
			data, err := io.ReadAll(body)
			if err != nil {
				t.Error(err)
				w.WriteHeader(500)
				return
			}
			objects[r.URL.Path] = data
			w.Header().Set("ETag", fmt.Sprintf("\"%x\"", md5.Sum(data)))
		case http.MethodHead, http.MethodGet:
			data, exists := objects[r.URL.Path]
			if !exists {
				http.Error(w, "<Error><Code>NoSuchKey</Code></Error>", 404)
				return
			}
			w.Header().Set("Content-Length", fmt.Sprint(len(data)))
			w.Header().Set("Last-Modified", time.Unix(1_700_000_000, 0).UTC().Format(http.TimeFormat))
			w.Header().Set("ETag", fmt.Sprintf("\"%x\"", md5.Sum(data)))
			if r.Method == http.MethodGet {
				_, _ = w.Write(data)
			}
		case http.MethodDelete:
			delete(objects, r.URL.Path)
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected S3 request %s %s", r.Method, r.URL)
			w.WriteHeader(400)
		}
	}))
	defer server.Close()
	s3, err := storage.NewS3ArchiveStore(storage.S3ArchiveStoreConfig{
		EndpointUrl: server.URL, Bucket: "archives", Region: "us-east-1",
		AccessKeyId: "TEMP_ACCESS_KEY", SecretAccessKey: "temporary-secret", SessionToken: "temporary-session",
	})
	if err != nil {
		t.Fatal(err)
	}
	store := &storage.SchemeArchiveStore{S3: s3}
	artifacts := Artifacts{Root: t.TempDir()}
	ref := reference()
	ref.ArcPath = "s3://archives/checkpoints/org/" + ref.CheckpointID + "/archive.boxlite"
	record := mustExport(t, artifacts, ref, captureBytes("portable checkpoint bytes"))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := artifacts.Upload(ctx, record, store); err != nil {
		t.Fatal(err)
	}
	imported, err := artifacts.Download(ctx, record, uuid.NewString(), store)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(imported.Path)
	if err != nil || string(data) != "portable checkpoint bytes" {
		t.Fatalf("download = %q, %v", data, err)
	}
	if err := imported.Close(); err != nil {
		t.Fatal(err)
	}
	path := "/archives/checkpoints/org/" + ref.CheckpointID + "/archive.boxlite"
	mu.Lock()
	objects[path][0] ^= 1
	mu.Unlock()
	if _, err := artifacts.Download(ctx, record, uuid.NewString(), store); err == nil {
		t.Fatal("an archive corrupted across the S3 boundary passed checksum validation")
	}
	mu.Lock()
	objects[path+".neighbor"] = []byte("retain")
	mu.Unlock()
	if err := store.Remove(ctx, ref.ArcPath); err != nil {
		t.Fatal(err)
	}
	if err := store.Remove(ctx, ref.ArcPath); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if _, exists := objects[path]; exists {
		t.Fatal("checkpoint archive survived deletion")
	}
	if string(objects[path+".neighbor"]) != "retain" {
		t.Fatal("deletion affected another archive")
	}
}
