package boxlite

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
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
	full := maps.Clone(info)
	full["id"], full["kind"], full["memory_size_bytes"] = "checkpoint-2", "full", 0
	future := maps.Clone(info)
	future["id"], future["kind"], future["memory_size_bytes"] = "checkpoint-3", "future", 4096
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
			response = map[string]any{"checkpoints": []any{info, full, future}}
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
	if captured.Kind != CheckpointKindDisk || captured.MemorySizeBytes != nil {
		t.Fatalf("disk metadata: %+v", captured)
	}
	list, err := checkpoints.List(ctx)
	if err != nil || len(list) != 3 {
		t.Fatalf("list: %+v %v", list, err)
	}
	if disk := list[0]; disk.ID != "checkpoint-1" || disk.SourceBoxID != "source-1" || disk.Kind != CheckpointKindDisk || disk.MemorySizeBytes != nil {
		t.Fatalf("disk list metadata: %+v", disk)
	}
	if full := list[1]; full.ID != "checkpoint-2" || full.Kind != CheckpointKindFull || full.MemorySizeBytes == nil || *full.MemorySizeBytes != 0 {
		t.Fatalf("full list metadata: %+v", full)
	}
	if future := list[2]; future.ID != "checkpoint-3" || future.Kind != CheckpointKindUnknown || future.MemorySizeBytes == nil || *future.MemorySizeBytes != 4096 {
		t.Fatalf("unknown list metadata: %+v", future)
	}
	detail, err := checkpoints.Get(ctx, "checkpoint-1")
	if err != nil || detail.ID != captured.ID || detail.State != "failed" || detail.ErrorReason != "archive upload failed" {
		t.Fatalf("get: %+v %v", detail, err)
	}
	created, err := runtime.Create(ctx, "", WithCheckpoint("checkpoint-1"), WithName("worker"))
	if err != nil {
		t.Fatal(err)
	}
	defer created.Close()
	if created.ID() != "target-1" {
		t.Fatalf("created: %s", created.ID())
	}
	if _, err := runtime.Create(ctx, "", WithCheckpoint("checkpoint-1"), WithCPUs(2)); !IsInvalidArgument(err) {
		t.Fatalf("override must be refused: %v", err)
	}
	for _, force := range []bool{false, true} {
		if err := checkpoints.Remove(ctx, "checkpoint-1", force); err != nil {
			t.Fatal(err)
		}
	}
	unnamed, err := runtime.Create(ctx, "", WithCheckpoint("checkpoint-1"))
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
		{"POST", "/v1/boxes", map[string]any{"checkpoint_id": "checkpoint-1", "name": "worker"}},
		{"DELETE", "/v1/checkpoints/checkpoint-1", nil},
		{"DELETE", "/v1/checkpoints/checkpoint-1?force=true", nil},
		{"POST", "/v1/boxes", map[string]any{"checkpoint_id": "checkpoint-1"}},
		{"POST", "/v1/checkpoints", map[string]any{"source_box_id": "source-1"}},
	}
	if len(requests) != len(expected)+1 || !reflect.DeepEqual(requests[:len(expected)], expected) {
		t.Fatalf("requests: %+v", requests)
	}
	if last := requests[len(expected)]; last.URI != "/v1/boxes" || last.Body["image"] != "alpine:latest" || last.Body["checkpoint_id"] != nil {
		t.Fatalf("legacy request changed: %+v", last)
	}
}

func TestCheckpointCreateWithOptions(t *testing.T) {
	zero, used := uint64(0), uint64(4096)
	post, config := "POST /v1/checkpoints", "GET /v1/config"
	for _, tc := range []struct {
		name       string
		kind       CheckpointKind
		enabled    bool
		response   string
		wantKind   CheckpointKind
		wantMemory *uint64
		wantCalls  []string
	}{
		{"default", "", false, "", CheckpointKindDisk, nil, []string{post}},
		{"disk", CheckpointKindDisk, false, "", CheckpointKindDisk, nil, []string{post}},
		{"full zero", CheckpointKindFull, true, `,"kind":"full","memory_size_bytes":0`, CheckpointKindFull, &zero, []string{config, post}},
		{"full nonzero", CheckpointKindFull, true, `,"kind":"full","memory_size_bytes":4096`, CheckpointKindFull, &used, []string{config, post}},
		{"full disabled", CheckpointKindFull, false, "", "", nil, []string{config}},
		{"unknown response", "", false, `,"kind":"future"`, CheckpointKindUnknown, nil, []string{post}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var mu sync.Mutex
			var calls []string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				calls = append(calls, r.Method+" "+r.URL.RequestURI())
				mu.Unlock()
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/v1/config" {
					_ = json.NewEncoder(w).Encode(map[string]any{"capabilities": map[string]bool{"memory_checkpoints_enabled": tc.enabled}})
					return
				}
				want := map[string]any{"source_box_id": "source-1", "name": "base"}
				if tc.kind == CheckpointKindFull {
					want["kind"] = "full"
				}
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !reflect.DeepEqual(body, want) {
					t.Errorf("request body = %v, want %v (decode error: %v)", body, want, err)
				}
				_, _ = w.Write([]byte(`{"id":"cp-1","name":"base","source_box_id":"source-1","created_at":"2026-11-06T00:00:00Z","size_bytes":8192` + tc.response + "}"))
			}))
			defer server.Close()
			runtime, err := NewRest(BoxliteRestOptions{URL: server.URL})
			if err != nil {
				t.Fatal(err)
			}
			defer runtime.Close()
			info, err := runtime.Checkpoints().CreateWithOptions(context.Background(), "source-1", "base", CheckpointOptions{Kind: tc.kind})
			if tc.kind == CheckpointKindFull && !tc.enabled {
				requireErrorCode(t, err, ErrUnsupported, "full checkpoint")
			} else if err != nil || info == nil || info.Kind != tc.wantKind || !reflect.DeepEqual(info.MemorySizeBytes, tc.wantMemory) {
				t.Fatalf("metadata = %+v, error = %v, want kind %q and memory %v", info, err, tc.wantKind, tc.wantMemory)
			}
			mu.Lock()
			defer mu.Unlock()
			if !reflect.DeepEqual(calls, tc.wantCalls) {
				t.Fatalf("requests = %v, want %v", calls, tc.wantCalls)
			}
		})
	}
}

func TestCheckpointManagementRejectsInvalidInputsAndClosedRuntime(t *testing.T) {
	ctx := context.Background()
	checkpoints := (&Runtime{}).Checkpoints()
	for _, kind := range []CheckpointKind{"bogus", CheckpointKindUnknown, "full\x00"} {
		if _, err := checkpoints.CreateWithOptions(ctx, "source-1", "base", CheckpointOptions{Kind: kind}); !IsInvalidArgument(err) {
			t.Fatalf("create with kind %q: %v", kind, err)
		}
	}
	if _, err := checkpoints.CreateWithOptions(ctx, "source-1", "bad\x00name", CheckpointOptions{Kind: CheckpointKindFull}); !IsInvalidArgument(err) {
		t.Fatalf("create with invalid name: %v", err)
	}
	for _, key := range []string{"", "bad\x00suffix"} {
		if _, err := checkpoints.Get(ctx, key); !IsInvalidArgument(err) {
			t.Fatalf("get %q: %v", key, err)
		}
		if _, err := checkpoints.Create(ctx, key, ""); !IsInvalidArgument(err) {
			t.Fatalf("create %q: %v", key, err)
		}
		if err := checkpoints.Remove(ctx, key, true); !IsInvalidArgument(err) {
			t.Fatalf("remove %q: %v", key, err)
		}
	}
	for _, config := range []*boxConfig{{checkpoint: "base"}, {checkpoint: "base", rootfsPath: "/tmp"}} {
		image := "alpine:latest"
		if config.rootfsPath != "" {
			image = ""
		}
		if _, err := buildCOptions(image, config); err == nil {
			t.Fatalf("checkpoint with another rootfs source must fail: %+v", config)
		}
	}
	if _, err := checkpoints.List(ctx); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("closed list: %v", err)
	}
}

func TestCheckpointRejectsExplicitDefaults(t *testing.T) {
	for _, key := range []string{"", "base\x00suffix"} {
		cfg := &boxConfig{}
		WithCheckpoint(key)(cfg)
		if err := buildAndFreeCOptions("", cfg); !IsInvalidArgument(err) {
			t.Errorf("checkpoint %q: expected invalid argument, got %v", key, err)
		}
	}
	for i, override := range []BoxOption{
		WithDetach(false), WithMemory(0), WithDiskSize(0), WithUser(""),
		WithWorkDir(""), WithCmd(), WithEntrypoint(), WithRootfsPath(""),
		WithAutoRemove(true), WithAutoDeleteInterval(0), WithAutoResumeEnabled(true),
		WithNetwork(NetworkSpec{}), WithAdvancedOptions(nil),
	} {
		cfg := &boxConfig{}
		WithCheckpoint("base")(cfg)
		override(cfg)
		if err := buildAndFreeCOptions("", cfg); !IsInvalidArgument(err) {
			t.Errorf("override %d: expected invalid argument, got %v", i, err)
		}
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
