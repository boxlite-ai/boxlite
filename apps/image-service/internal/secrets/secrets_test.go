// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package secrets

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

const version = "projects/123/secrets/registry-credential-abc/versions/1"

// secretManagerAnswering stands in for Secret Manager, answering every read
// with status and body, and counting the reads that reached it.
func secretManagerAnswering(t *testing.T, status int, body string) (*secretManager, *atomic.Int64, *atomic.Value) {
	t.Helper()
	var reads atomic.Int64
	var path atomic.Value
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		path.Store(r.URL.Path)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	return &secretManager{client: server.Client(), endpoint: server.URL + "/v1/"}, &reads, &path
}

func TestSecretManagerReturnsThePayloadOfTheNamedVersion(t *testing.T) {
	// "hunter2", base64: the payload is bytes on the wire, not text.
	store, _, path := secretManagerAnswering(t, http.StatusOK, `{"name":"x","payload":{"data":"aHVudGVyMg=="}}`)

	password, err := store.Read(context.Background(), version)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if password != "hunter2" {
		t.Errorf("Read = %q, want the decoded payload", password)
	}
	if want := "/v1/" + version + ":access"; path.Load() != want {
		t.Errorf("read %v, want %s", path.Load(), want)
	}
}

func TestSecretManagerRefusesAVersionThatIsNotOneBeforeAskingForIt(t *testing.T) {
	store, reads, _ := secretManagerAnswering(t, http.StatusOK, `{}`)

	for _, named := range []string{
		"projects/123/secrets/registry-credential-abc/versions/latest",
		"projects/123/secrets/../../other/versions/1",
		"projects/123/secrets/registry-credential-abc/versions/1?alt=json",
		"registry-credential-abc",
	} {
		if _, err := store.Read(context.Background(), named); !errors.Is(err, ErrInvalidVersion) {
			t.Errorf("Read(%q) = %v, want ErrInvalidVersion", named, err)
		}
	}
	if reads.Load() != 0 {
		t.Errorf("Secret Manager was asked %d times, want a refusal before any request", reads.Load())
	}
}

func TestSecretManagerReportsARefusalWithoutItsBody(t *testing.T) {
	store, _, _ := secretManagerAnswering(t, http.StatusForbidden, `{"error":{"message":"echoed-detail"}}`)

	_, err := store.Read(context.Background(), version)
	if err == nil || !strings.Contains(err.Error(), "403") {
		t.Fatalf("Read = %v, want the status", err)
	}
	if strings.Contains(err.Error(), "echoed-detail") {
		t.Errorf("the error carries the response body: %v", err)
	}
}

func TestFileReaderReadsOneFileAndCannotLeaveItsDirectory(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "registry-credential-abc"), []byte("hunter2"), 0o600); err != nil {
		t.Fatal(err)
	}
	reader, err := NewReader(context.Background(), "file", directory)
	if err != nil {
		t.Fatalf("NewReader: %v", err)
	}

	password, err := reader.Read(context.Background(), "registry-credential-abc")
	if err != nil || password != "hunter2" {
		t.Errorf("Read = %q, %v; want the file's contents", password, err)
	}
	for _, named := range []string{"../registry-credential-abc", "sub/registry-credential-abc", ""} {
		if _, err := reader.Read(context.Background(), named); !errors.Is(err, ErrInvalidVersion) {
			t.Errorf("Read(%q) = %v, want ErrInvalidVersion", named, err)
		}
	}
}

func TestNewReaderLeavesPrivateRegistriesOffWithoutAStore(t *testing.T) {
	reader, err := NewReader(context.Background(), "", "")
	if err != nil || reader != nil {
		t.Errorf("NewReader(\"\") = %v, %v; want no reader and no error", reader, err)
	}
	if _, err := NewReader(context.Background(), "vault", ""); err == nil {
		t.Error("an unknown store was accepted")
	}
}
