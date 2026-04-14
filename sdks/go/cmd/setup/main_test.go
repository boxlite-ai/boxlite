package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDownloadToModCacheExtractsLibraryAndHeader(t *testing.T) {
	t.Parallel()

	archive := createTestArchive(t, map[string]string{
		"boxlite-c-v0.8.2-darwin-arm64/lib/libboxlite.a":  "test archive",
		"boxlite-c-v0.8.2-darwin-arm64/include/boxlite.h": "#ifndef BOXLITE_H\n",
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(archive)
	}))
	defer server.Close()

	destDir := t.TempDir()
	if err := os.Chmod(destDir, 0o555); err != nil {
		t.Fatalf("Chmod destDir read-only: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Chmod(destDir, 0o755)
	})

	if err := downloadToModCache(server.URL, destDir); err != nil {
		t.Fatalf("downloadToModCache: %v", err)
	}

	libPath := filepath.Join(destDir, "libboxlite.a")
	headerPath := filepath.Join(destDir, "include", "boxlite.h")

	libData, err := os.ReadFile(libPath)
	if err != nil {
		t.Fatalf("ReadFile libboxlite.a: %v", err)
	}
	if string(libData) != "test archive" {
		t.Fatalf("libboxlite.a mismatch: got %q", string(libData))
	}

	headerData, err := os.ReadFile(headerPath)
	if err != nil {
		t.Fatalf("ReadFile boxlite.h: %v", err)
	}
	if !strings.Contains(string(headerData), "#ifndef BOXLITE_H") {
		t.Fatalf("boxlite.h missing expected contents: %q", string(headerData))
	}
}

func TestDownloadToModCacheRequiresHeader(t *testing.T) {
	t.Parallel()

	archive := createTestArchive(t, map[string]string{
		"boxlite-c-v0.8.2-darwin-arm64/lib/libboxlite.a": "test archive",
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(archive)
	}))
	defer server.Close()

	destDir := t.TempDir()
	if err := os.Chmod(destDir, 0o555); err != nil {
		t.Fatalf("Chmod destDir read-only: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Chmod(destDir, 0o755)
	})

	err := downloadToModCache(server.URL, destDir)
	if err == nil {
		t.Fatal("expected downloadToModCache to fail when include/boxlite.h is missing")
	}
	if !strings.Contains(err.Error(), "include/boxlite.h not found") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestDownloadToModCacheRequiresLibrary(t *testing.T) {
	t.Parallel()

	archive := createTestArchive(t, map[string]string{
		"boxlite-c-v0.8.2-darwin-arm64/include/boxlite.h": "#ifndef BOXLITE_H\n",
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(archive)
	}))
	defer server.Close()

	destDir := t.TempDir()
	if err := os.Chmod(destDir, 0o555); err != nil {
		t.Fatalf("Chmod destDir read-only: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Chmod(destDir, 0o755)
	})

	err := downloadToModCache(server.URL, destDir)
	if err == nil {
		t.Fatal("expected downloadToModCache to fail when libboxlite.a is missing")
	}
	if !strings.Contains(err.Error(), "libboxlite.a not found") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func createTestArchive(t *testing.T, files map[string]string) []byte {
	t.Helper()

	var archive bytes.Buffer
	gz := gzip.NewWriter(&archive)
	tw := tar.NewWriter(gz)

	for name, content := range files {
		data := []byte(content)
		hdr := &tar.Header{
			Name: name,
			Mode: 0o644,
			Size: int64(len(data)),
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatalf("WriteHeader(%s): %v", name, err)
		}
		if _, err := tw.Write(data); err != nil {
			t.Fatalf("Write(%s): %v", name, err)
		}
	}

	if err := tw.Close(); err != nil {
		t.Fatalf("tar close: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}

	return archive.Bytes()
}
