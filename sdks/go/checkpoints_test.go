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
	"time"
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
	created, err := runtime.ImportWithOptions(ctx, "", "worker", ImportOptions{CheckpointID: "checkpoint-1"})
	if err != nil {
		t.Fatal(err)
	}
	defer created.Close()
	if created.ID() != "target-1" || created.Name() != "worker" {
		t.Fatalf("created: %s %q", created.ID(), created.Name())
	}
	recovered, err := runtime.ImportWithOptions(ctx, "", "", ImportOptions{CheckpointID: "checkpoint-1", BoxID: created.ID()})
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
	unnamed, err := runtime.ImportWithOptions(ctx, "", "", ImportOptions{CheckpointID: "checkpoint-1"})
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
		if _, err := checkpoints.runtime.ImportWithOptions(ctx, "", "", ImportOptions{CheckpointID: key}); !IsInvalidArgument(err) {
			t.Fatalf("create box %q: %v", key, err)
		}
		if err := checkpoints.Remove(ctx, key, true); !IsInvalidArgument(err) {
			t.Fatalf("remove %q: %v", key, err)
		}
	}
	for _, target := range []string{"target", "bad\x00suffix"} {
		if _, err := checkpoints.runtime.ImportWithOptions(ctx, "", "conflicting-name", ImportOptions{CheckpointID: "base", BoxID: target}); !IsInvalidArgument(err) {
			t.Fatalf("conflicting import target %q: %v", target, err)
		}
	}
	if _, err := checkpoints.List(ctx); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("closed list: %v", err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := checkpoints.runtime.ImportWithOptions(cancelled, "", "worker", ImportOptions{CheckpointID: "base"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled: %v", err)
	}
}

func TestCheckpointManagementPropagatesBoundaryFailures(t *testing.T) {
	operations := []struct {
		name string
		call func(context.Context, *Checkpoints, string) error
	}{
		{"create", func(ctx context.Context, c *Checkpoints, key string) error {
			_, err := c.Create(ctx, key, "")
			return err
		}},
		{"get", func(ctx context.Context, c *Checkpoints, key string) error { _, err := c.Get(ctx, key); return err }},
		{"list", func(ctx context.Context, c *Checkpoints, _ string) error { _, err := c.List(ctx); return err }},
		{"remove", func(ctx context.Context, c *Checkpoints, key string) error { return c.Remove(ctx, key, false) }},
		{"import", func(ctx context.Context, c *Checkpoints, key string) error {
			_, err := c.runtime.ImportWithOptions(ctx, "", "", ImportOptions{CheckpointID: key})
			return err
		}},
	}
	for _, operation := range operations {
		t.Run(operation.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusConflict)
				_, _ = w.Write([]byte(`{"error":{"code":"invalid_state","message":"checkpoint unavailable"}}`))
			}))
			defer server.Close()
			runtime, err := NewRest(BoxliteRestOptions{URL: server.URL})
			if err != nil {
				t.Fatal(err)
			}
			defer runtime.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := operation.call(ctx, runtime.Checkpoints(), "base"); err == nil || !strings.Contains(err.Error(), "checkpoint unavailable") {
				t.Fatalf("backend failure was lost: %v", err)
			}
			if operation.name != "list" {
				if err := operation.call(ctx, runtime.Checkpoints(), "\xff"); !IsInvalidArgument(err) {
					t.Fatalf("native UTF-8 rejection was lost: %v", err)
				}
			}
			cancelled, stop := context.WithCancel(context.Background())
			stop()
			if err := operation.call(cancelled, runtime.Checkpoints(), "base"); !errors.Is(err, context.Canceled) {
				t.Fatalf("cancelled admission: %v", err)
			}
			if err := operation.call(context.Background(), nil, "base"); !errors.Is(err, ErrRuntimeClosed) {
				t.Fatalf("nil manager: %v", err)
			}
			runtime.closingOnce.Do(func() { close(runtime.closing) })
			if err := operation.call(context.Background(), runtime.Checkpoints(), "base"); !errors.Is(err, ErrRuntimeClosed) {
				t.Fatalf("closing runtime: %v", err)
			}
		})
	}
}

func TestCheckpointManagementCancellationAfterNativeAdmission(t *testing.T) {
	for _, remove := range []bool{false, true} {
		for _, closing := range []bool{false, true} {
			t.Run(map[bool]string{false: "metadata", true: "remove"}[remove]+map[bool]string{false: "/cancel", true: "/close"}[closing], func(t *testing.T) {
				started, release := make(chan struct{}), make(chan struct{})
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					close(started)
					select {
					case <-release:
					case <-r.Context().Done():
						return
					}
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusConflict)
					_, _ = w.Write([]byte(`{"error":{"code":"invalid_state","message":"late failure"}}`))
				}))
				defer server.Close()
				runtime, err := NewRest(BoxliteRestOptions{URL: server.URL})
				if err != nil {
					t.Fatal(err)
				}
				defer runtime.Close()
				defer close(release)
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				done := make(chan error, 1)
				go func() {
					if remove {
						done <- runtime.Checkpoints().Remove(ctx, "base", false)
					} else {
						_, err := runtime.Checkpoints().Get(ctx, "base")
						done <- err
					}
				}()
				select {
				case <-started:
				case err := <-done:
					t.Fatalf("finished before admission: %v", err)
				case <-time.After(5 * time.Second):
					t.Fatal("native request was not admitted")
				}
				expected := error(context.Canceled)
				if closing {
					runtime.closingOnce.Do(func() { close(runtime.closing) })
					expected = ErrRuntimeClosed
				} else {
					cancel()
				}
				select {
				case err := <-done:
					if !errors.Is(err, expected) {
						t.Fatalf("cancellation: %v", err)
					}
				case <-time.After(time.Second):
					t.Fatal("cancellation waited for native completion")
				}
			})
		}
	}
}

func TestCheckpointImportSourceSelectionRejectsConflicts(t *testing.T) {
	runtime := &Runtime{}
	for _, input := range []struct {
		path, name string
		options    ImportOptions
	}{
		{"", "", ImportOptions{}},
		{"file.boxlite", "", ImportOptions{CheckpointID: "base"}},
		{"file.boxlite", "", ImportOptions{BoxID: "target"}},
		{"", "worker", ImportOptions{CheckpointID: "base", BoxID: "target"}},
		{"", "", ImportOptions{CheckpointID: "base", BoxID: "bad\x00target"}},
	} {
		if _, err := runtime.ImportWithOptions(t.Context(), input.path, input.name, input.options); !IsInvalidArgument(err) {
			t.Fatalf("invalid source %#v: %v", input, err)
		}
	}
	if _, err := runtime.ImportWithOptions(t.Context(), "", "", ImportOptions{CheckpointID: "base"}); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("closed import: %v", err)
	}
}
