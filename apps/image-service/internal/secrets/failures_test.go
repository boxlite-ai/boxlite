// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package secrets

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"
)

func TestSecretManagerRejectsMalformedPayloads(t *testing.T) {
	for _, test := range []struct {
		name, body, want string
	}{
		{"invalid JSON", `{"payload":`, "not a secret payload"},
		{"oversized JSON", `{"padding":"` + strings.Repeat("x", payloadLimit) + `"}`, "not a secret payload"},
		{"invalid base64", `{"payload":{"data":"not-base64!"}}`, "not base64"},
	} {
		t.Run(test.name, func(t *testing.T) {
			store, reads, _ := secretManagerAnswering(t, http.StatusOK, test.body)
			password, err := store.Read(context.Background(), version)
			if password != "" || err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("Read returned a password or the wrong error: %v", err)
			}
			if reads.Load() != 1 {
				t.Fatalf("reads = %d, want 1", reads.Load())
			}
		})
	}
}

func TestSecretManagerCancellationDoesNotReachTheServer(t *testing.T) {
	store, reads, _ := secretManagerAnswering(t, http.StatusOK, `{}`)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	password, err := store.Read(ctx, version)
	if password != "" || !errors.Is(err, context.Canceled) {
		t.Fatalf("Read = error %v, want cancellation and no password", err)
	}
	if reads.Load() != 0 {
		t.Fatalf("cancelled read reached the server %d times", reads.Load())
	}
}

func TestFileReaderPreservesMissingFileError(t *testing.T) {
	store, err := NewReader(context.Background(), "file", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	password, err := store.Read(context.Background(), "registry-credential-missing")
	if password != "" || !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Read = error %v, want missing file and no password", err)
	}
}
