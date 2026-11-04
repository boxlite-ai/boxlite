//go:build boxlite_dev

// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package boxlite

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
)

// Recover must validate the saved requirement before destroying anything.
// This uses the existing recovery DTO with nesting omitted, so it also runs
// with every production file restored to the pre-fix contract.
func TestNestedRecoveryOmittedRequirementNeverDeletesSavedNestedBox(t *testing.T) {
	var deletes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodDelete:
			deletes.Add(1)
			// A delete can take effect even when its response fails. Returning
			// an error also keeps this regression clear of volume cleanup.
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"code":"internal","message":"delete response failed"}`))
		case r.Method == http.MethodGet && deletes.Load() == 0:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"box_id": "saved-native-id", "name": "saved-nested", "status": "stopped",
				"created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
				"pid": nil, "image": "alpine:latest", "cpus": 1, "memory_mib": 128,
				"advanced": map[string]bool{"nested_virtualization": true},
			})
		case r.Method == http.MethodGet:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"code":"not_found","message":"box was deleted"}`))
		default:
			// Bound the old recreation journey after it has already deleted
			// the box. The assertion below checks deletion, not this error.
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"code":"internal","message":"no replacement"}`))
		}
	}))
	defer server.Close()
	runtime, err := sdk.NewRest(sdk.BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	if info, err := runtime.GetInfo(t.Context(), "saved-nested"); err != nil || info.ID != "saved-native-id" {
		t.Fatalf("saved box is not reachable: info=%+v err=%v", info, err)
	}
	client := &Client{runtime: runtime, logger: slog.Default(), homeDir: t.TempDir()}
	_ = client.RecoverBox(t.Context(), "saved-nested", dto.RecoverBoxDTO{
		OsUser: "root", OutboundEnabled: boolPtr(false), ErrorReason: "recover",
	})
	if got := deletes.Load(); got != 0 {
		t.Fatalf("recovery deleted the saved nested box before validating its requirement: DELETE count=%d, want 0", got)
	}
}
