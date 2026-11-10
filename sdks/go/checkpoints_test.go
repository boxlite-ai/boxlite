package boxlite

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func TestCheckpointManagementNativeRestBoundary(t *testing.T) {
	type request struct {
		Method, URI string
		Body        map[string]any
	}
	var mu sync.Mutex
	var requests []request
	info := map[string]any{"id": "checkpoint-1", "name": "base", "source_box_id": "source-1", "created_at": "2026-11-06T00:00:00Z", "size_bytes": 4096, "state": "ready"}
	box := map[string]any{"box_id": "target-1", "name": "worker", "status": "stopped", "image": "alpine:latest", "cpus": 2, "memory_mib": 512, "created_at": info["created_at"], "updated_at": info["created_at"]}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if r.Body != nil && r.ContentLength != 0 {
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode request: %v", err)
			}
		}
		mu.Lock()
		requests = append(requests, request{r.Method, r.URL.RequestURI(), body})
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		var response any = info
		if strings.HasPrefix(r.URL.Path, "/v1/boxes") {
			response = box
		} else if r.Method == http.MethodGet && r.URL.Path == "/v1/checkpoints" {
			response = map[string]any{"checkpoints": []any{info}}
		}
		if r.Method == http.MethodGet && r.URL.Path == "/v1/checkpoints/checkpoint-1" {
			failed := make(map[string]any, len(info)+1)
			for key, value := range info {
				failed[key] = value
			}
			failed["state"], failed["error_reason"] = "failed", "archive upload failed"
			response = failed
		}
		if err := json.NewEncoder(w).Encode(response); err != nil {
			t.Errorf("encode: %v", err)
		}
	}))
	defer server.Close()
	runtime, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	ctx := context.Background()
	checkpoints := runtime.Checkpoints()
	captured, err := checkpoints.Create(ctx, "source-1", "base")
	if err != nil {
		t.Fatal(err)
	}
	if captured.ID != "checkpoint-1" || captured.State != "ready" || captured.SizeBytes != 4096 {
		t.Fatalf("metadata: %+v", captured)
	}
	list, err := checkpoints.List(ctx)
	if err != nil || len(list) != 1 || list[0].SourceBoxID != "source-1" {
		t.Fatalf("list: %+v %v", list, err)
	}
	detail, err := checkpoints.Get(ctx, "checkpoint-1")
	if err != nil || detail.ID != captured.ID || detail.State != "failed" || detail.ErrorReason != "archive upload failed" {
		t.Fatalf("get: %+v %v", detail, err)
	}
	created, err := checkpoints.ImportBox(ctx, "checkpoint-1", "worker", "")
	if err != nil {
		t.Fatal(err)
	}
	defer created.Close()
	if created.ID() != "target-1" || created.Name() != "worker" {
		t.Fatalf("created: %s %q", created.ID(), created.Name())
	}
	recovered, err := checkpoints.ImportBox(ctx, "checkpoint-1", "", created.ID())
	if err != nil {
		t.Fatal(err)
	}
	defer recovered.Close()
	if recovered.ID() != created.ID() || recovered.Name() != "worker" {
		t.Fatalf("recovered: %s %q", recovered.ID(), recovered.Name())
	}
	for _, force := range []bool{false, true} {
		if err := checkpoints.Remove(ctx, "checkpoint-1", force); err != nil {
			t.Fatal(err)
		}
	}
	unnamed, err := checkpoints.ImportBox(ctx, "checkpoint-1", "", "")
	if err != nil {
		t.Fatal(err)
	}
	defer unnamed.Close()
	if _, err = checkpoints.Create(ctx, "source-1", ""); err != nil {
		t.Fatal(err)
	}
	legacy, err := runtime.Create(ctx, "alpine:latest")
	if err != nil {
		t.Fatal(err)
	}
	defer legacy.Close()
	mu.Lock()
	defer mu.Unlock()
	expected := []request{
		{"POST", "/v1/checkpoints", map[string]any{"source_box_id": "source-1", "name": "base"}},
		{"GET", "/v1/checkpoints", nil},
		{"GET", "/v1/checkpoints/checkpoint-1", nil},
		{"POST", "/v1/boxes/import", map[string]any{"checkpoint_id": "checkpoint-1", "name": "worker"}},
		{"POST", "/v1/boxes/import", map[string]any{"checkpoint_id": "checkpoint-1", "box_id": "target-1"}},
		{"DELETE", "/v1/checkpoints/checkpoint-1", nil},
		{"DELETE", "/v1/checkpoints/checkpoint-1?force=true", nil},
		{"POST", "/v1/boxes/import", map[string]any{"checkpoint_id": "checkpoint-1"}},
		{"POST", "/v1/checkpoints", map[string]any{"source_box_id": "source-1"}},
	}
	if len(requests) != len(expected)+1 || !reflect.DeepEqual(requests[:len(expected)], expected) {
		t.Fatalf("requests: %+v", requests)
	}
	if last := requests[len(expected)]; last.URI != "/v1/boxes" || last.Body["image"] != "alpine:latest" || last.Body["checkpoint_id"] != nil {
		t.Fatalf("legacy request changed: %+v", last)
	}
}

func TestCheckpointManagementRejectsInvalidInputsAndClosedRuntime(t *testing.T) {
	ctx := context.Background()
	checkpoints := (&Runtime{}).Checkpoints()
	for _, key := range []string{"", "bad\x00suffix"} {
		if _, err := checkpoints.Get(ctx, key); !IsInvalidArgument(err) {
			t.Fatalf("get %q: %v", key, err)
		}
		if _, err := checkpoints.Create(ctx, key, ""); !IsInvalidArgument(err) {
			t.Fatalf("create %q: %v", key, err)
		}
		if _, err := checkpoints.ImportBox(ctx, key, "", ""); !IsInvalidArgument(err) {
			t.Fatalf("create box %q: %v", key, err)
		}
		if err := checkpoints.Remove(ctx, key, true); !IsInvalidArgument(err) {
			t.Fatalf("remove %q: %v", key, err)
		}
	}
	for _, target := range []string{"target", "bad\x00suffix"} {
		if _, err := checkpoints.ImportBox(ctx, "base", "conflicting-name", target); !IsInvalidArgument(err) {
			t.Fatalf("conflicting import target %q: %v", target, err)
		}
	}
	if _, err := checkpoints.List(ctx); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("closed list: %v", err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := checkpoints.ImportBox(cancelled, "base", "worker", ""); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled: %v", err)
	}
	if _, err := NewRuntime(WithCheckpointDir("bad\x00directory")); !IsInvalidArgument(err) {
		t.Fatalf("directory: %v", err)
	}
}
