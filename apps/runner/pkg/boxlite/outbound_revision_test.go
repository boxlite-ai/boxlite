package boxlite

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/containerd/errdefs"
)

// Real SDK/C/Rust transport, controlled remote Runtime; no guest VM is started.
func TestOutboundRunnerClientCrossFFI(t *testing.T) {
	var stopped atomic.Bool
	var mu sync.Mutex
	current := sdk.OutboundSnapshot{Revision: "rev-a", Policy: sdk.OutboundPolicy{Mode: sdk.NetworkModeEnabled, AllowNet: []string{}}}
	replacements := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/v1/boxes/box1" {
			state := "running"
			if stopped.Load() {
				state = "stopped"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"box_id": "box1", "status": state, "created_at": "2026-07-14T00:00:00Z", "updated_at": "2026-07-14T00:00:00Z", "image": "alpine", "cpus": 1, "memory_mib": 256})
			return
		}
		mu.Lock()
		defer mu.Unlock()
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/boxes/box1/network/outbound":
			w.Header().Set("ETag", `"`+current.Revision+`"`)
			_ = json.NewEncoder(w).Encode(current.Policy)
		case "GET /v1/boxes/box1/network/outbound/status":
			status := sdk.OutboundStatus{Persisted: current, Observed: &sdk.OutboundSnapshotStatus{OutboundSnapshot: current, ApplicationState: sdk.OutboundConfirmed}, ApplicationState: sdk.OutboundConfirmed}
			if stopped.Load() {
				status.ApplicationState, status.Observed, status.ObservationError = sdk.OutboundUncertain, nil, "box is not running"
			}
			_ = json.NewEncoder(w).Encode(status)
		case "PUT /v1/boxes/box1/network/outbound/snapshot":
			replacements++
			if r.Header.Get("If-Match") != `"rev-a"` || r.Header.Get("X-Boxlite-Outbound-Revision") != "rev-b" {
				t.Errorf("wrong metadata: %v", r.Header)
			}
			var policy sdk.OutboundPolicy
			if err := json.NewDecoder(r.Body).Decode(&policy); err != nil {
				t.Error(err)
			}
			if policy.Mode != sdk.NetworkModeDisabled || len(policy.AllowNet) != 0 {
				t.Errorf("wrong policy: %+v", policy)
			}
			current = sdk.OutboundSnapshot{Policy: policy, Revision: r.Header.Get("X-Boxlite-Outbound-Revision")}
			w.Header().Set("ETag", `"`+current.Revision+`"`)
			_ = json.NewEncoder(w).Encode(policy)
		default:
			t.Errorf("unexpected operation (including boot): %s %s", r.Method, r.URL.Path)
			http.Error(w, "unexpected", 500)
		}
	}))
	defer server.Close()
	rt, err := sdk.NewRest(sdk.BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	client := &Client{runtime: rt, logger: slog.Default(), boxes: make(map[string]*sdk.Box)}
	cached, err := rt.Get(t.Context(), "box1")
	if err != nil {
		t.Fatal(err)
	}
	client.boxes["box1"] = cached
	defer cached.Close()
	defer func() {
		for _, box := range client.boxes {
			_ = box.Close()
		}
	}()
	snapshot, err := client.OutboundSnapshot(t.Context(), "box1")
	if err != nil || snapshot.Revision != "rev-a" {
		t.Fatalf("snapshot: %+v %v", snapshot, err)
	}
	outcome, err := client.ReplaceOutboundSnapshot(t.Context(), "box1", "rev-a", sdk.OutboundSnapshot{Revision: "rev-b", Policy: sdk.OutboundPolicy{Mode: sdk.NetworkModeDisabled}})
	if err != nil || outcome != sdk.OutboundApplied {
		t.Fatalf("replace: %s %v", outcome, err)
	}
	status, err := client.OutboundStatus(t.Context(), "box1")
	if err != nil || status.ApplicationState != sdk.OutboundConfirmed || status.Persisted.Revision != "rev-b" {
		t.Fatalf("status: %+v %v", status, err)
	}
	stopped.Store(true)
	if _, err := client.ReplaceOutboundSnapshot(t.Context(), "box1", "rev-b", sdk.OutboundSnapshot{Revision: "rev-c", Policy: sdk.OutboundPolicy{Mode: sdk.NetworkModeEnabled}}); !sdk.IsInvalidState(err) {
		t.Fatalf("stopped mutation: %v", err)
	}
	status, err = client.OutboundStatus(t.Context(), "box1")
	if err != nil || status.ApplicationState != sdk.OutboundUncertain || status.Persisted.Revision != "rev-b" {
		t.Fatalf("stopped status: %+v %v", status, err)
	}
	for range 3 {
		if snapshot, err := client.OutboundSnapshot(t.Context(), "box1"); err != nil || snapshot.Revision != "rev-b" {
			t.Fatalf("repeated stopped snapshot: %+v %v", snapshot, err)
		}
		if status, err := client.OutboundStatus(t.Context(), "box1"); err != nil || status.ApplicationState != sdk.OutboundUncertain {
			t.Fatalf("repeated stopped status: %+v %v", status, err)
		}
	}
	t.Run("concurrent_stopped_readback", func(t *testing.T) {
		for range 4 {
			t.Run("poll", func(t *testing.T) {
				t.Parallel()
				if snapshot, err := client.OutboundSnapshot(t.Context(), "box1"); err != nil || snapshot.Revision != "rev-b" {
					t.Fatalf("concurrent stopped snapshot: %+v %v", snapshot, err)
				}
				if status, err := client.OutboundStatus(t.Context(), "box1"); err != nil || status.ApplicationState != sdk.OutboundUncertain {
					t.Fatalf("concurrent stopped status: %+v %v", status, err)
				}
			})
		}
	})
	client.mu.RLock()
	retained := client.boxes["box1"]
	client.mu.RUnlock()
	if retained != cached {
		t.Fatal("outbound readback evicted a borrowed Box handle; the evicted native handle cannot be released")
	}
	mu.Lock()
	defer mu.Unlock()
	if replacements != 1 {
		t.Fatalf("stopped replacement reached native transport: %d", replacements)
	}
}

func TestOutboundRunnerRejectsInvalidInputsBeforeRuntime(t *testing.T) {
	client := &Client{logger: slog.Default()}
	for _, tc := range []struct {
		expected  string
		candidate sdk.OutboundSnapshot
	}{
		{"", sdk.OutboundSnapshot{Revision: "rev-b"}},
		{"rev-a\x00suffix", sdk.OutboundSnapshot{Revision: "rev-b"}},
		{"rev-a", sdk.OutboundSnapshot{Revision: "initial"}},
		{"rev-a", sdk.OutboundSnapshot{Revision: "rev-a"}},
		{"rev-a", sdk.OutboundSnapshot{Revision: strings.Repeat("b", 129)}},
		{"rev-a", sdk.OutboundSnapshot{Revision: "rev-b", Policy: sdk.OutboundPolicy{Mode: sdk.NetworkModeDisabled, AllowNet: []string{"example.com"}}}},
	} {
		if tc.candidate.Policy.Mode == "" {
			tc.candidate.Policy.Mode = sdk.NetworkModeEnabled
		}
		_, err := client.ReplaceOutboundSnapshot(context.Background(), "box1", tc.expected, tc.candidate)
		if !sdk.IsInvalidArgument(err) && !errdefs.IsInvalidArgument(err) {
			t.Fatalf("invalid operation reached runtime: %v", err)
		}
	}
}
