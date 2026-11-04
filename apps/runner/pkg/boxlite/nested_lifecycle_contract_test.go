//go:build boxlite_dev

// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package boxlite

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/containerd/errdefs"
)

func TestNestedAdvertisementUsesValidatedRuntimeConfiguration(t *testing.T) {
	t.Setenv("BOXLITE_EXPERIMENTAL", "nested-virtualization")
	for _, features := range []string{"", " nested-virtualization "} {
		client, err := NewClient(t.Context(), ClientConfig{HomeDir: t.TempDir(), ExperimentalFeatures: features})
		if err != nil {
			t.Fatal(err)
		}
		if got := client.NestedVirtualizationEnabled(); got != (features != "") {
			t.Errorf("validated features %q advertised %t", features, got)
		}
		client.Close()
	}
}

func TestNestedSavedMetadataAndRecoveryCrossNativeBoundary(t *testing.T) {
	for _, tc := range []struct {
		name                                        string
		saved                                       *bool
		requested, allowed, failsRead, wantRecovery bool
	}{
		{"ordinary recovery", boolPtr(false), false, false, false, true},
		{"nested recovery", boolPtr(true), true, true, false, true},
		{"cannot drop saved true", boolPtr(true), false, true, false, false},
		{"cannot upgrade saved false", boolPtr(false), true, true, false, false},
		{"unknown saved intent", nil, false, false, false, false},
		{"authorization rollback", boolPtr(true), true, false, false, false},
		{"metadata read failure", boolPtr(true), true, true, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var deletes, creates atomic.Int32
			var exists atomic.Bool
			exists.Store(true)
			respondBox := func(w http.ResponseWriter) {
				info := map[string]any{
					"box_id": "native-id", "name": "cloud-box", "status": "stopped",
					"created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
					"image": "alpine:latest", "cpus": 1, "memory_mib": 128,
				}
				if tc.saved != nil {
					info["advanced"] = map[string]bool{"nested_virtualization": *tc.saved}
				}
				_ = json.NewEncoder(w).Encode(info)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch {
				case r.Method == http.MethodGet && r.URL.Path == "/v1/config":
					_, _ = w.Write([]byte(`{"capabilities":{"nested_virtualization_enabled":true}}`))
				case r.Method == http.MethodGet && tc.failsRead:
					w.WriteHeader(http.StatusInternalServerError)
					_, _ = w.Write([]byte(`{"code":"internal","message":"unreadable metadata"}`))
				case r.Method == http.MethodGet && exists.Load():
					respondBox(w)
				case r.Method == http.MethodGet:
					w.WriteHeader(http.StatusNotFound)
					_, _ = w.Write([]byte(`{"code":"not_found","message":"missing box"}`))
				case r.Method == http.MethodDelete:
					deletes.Add(1)
					exists.Store(false)
					// Exercise recovery's existing ambiguous-delete continuation,
					// without invoking unrelated host volume cleanup.
					w.WriteHeader(http.StatusInternalServerError)
					_, _ = w.Write([]byte(`{"code":"internal","message":"delete response failed"}`))
				case r.Method == http.MethodPost && r.URL.Path == "/v1/boxes":
					creates.Add(1)
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					if tc.requested {
						advanced, _ := body["advanced"].(map[string]any)
						if advanced["nested_virtualization"] != true {
							t.Errorf("lost saved requirement: %v", body)
						}
					} else if _, ok := body["advanced"]; ok {
						t.Errorf("ordinary recovery changed request shape: %v", body)
					}
					exists.Store(true)
					w.WriteHeader(http.StatusCreated)
					respondBox(w)
				case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/start"):
					respondBox(w)
				default:
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
					w.WriteHeader(http.StatusBadRequest)
				}
			}))
			defer server.Close()
			runtime, err := sdk.NewRest(sdk.BoxliteRestOptions{URL: server.URL})
			if err != nil {
				t.Fatal(err)
			}
			defer runtime.Close()
			client := &Client{runtime: runtime, logger: slog.Default(), boxes: make(map[string]*sdk.Box), nestedVirtualizationAllowed: tc.allowed}
			if !tc.failsRead {
				info, err := client.GetBoxInfo(t.Context(), "cloud-box")
				if err != nil {
					t.Fatal(err)
				}
				if tc.saved == nil {
					if info.NestedVirtualization != nil {
						t.Fatalf("invented saved intent: %+v", info)
					}
				} else if info.NestedVirtualization == nil || *info.NestedVirtualization != *tc.saved {
					t.Fatalf("lost native saved intent: %+v", info)
				}
			}
			err = client.RecoverBox(t.Context(), "cloud-box", dto.RecoverBoxDTO{
				OsUser: "root", OutboundEnabled: boolPtr(false), NestedVirtualization: tc.requested,
			})
			if tc.wantRecovery {
				if err != nil || deletes.Load() != 1 || creates.Load() != 1 {
					t.Fatalf("valid recovery: DELETE=%d POST=%d err=%v", deletes.Load(), creates.Load(), err)
				}
			} else {
				if err == nil || deletes.Load() != 0 || creates.Load() != 0 {
					t.Fatalf("rejected recovery mutated the box: DELETE=%d POST=%d err=%v", deletes.Load(), creates.Load(), err)
				}
				if !tc.failsRead && tc.allowed && !errdefs.IsConflict(err) {
					t.Fatalf("want immutable/unknown conflict, got %v", err)
				}
			}
		})
	}
}
