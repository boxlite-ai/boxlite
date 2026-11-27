package boxlite

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestRuntimeMountsReturnTheCallbackResultAndPreserveAbsence(t *testing.T) {
	const target = "/mount name & more"
	const base = "/v1/boxes/box1/mounts"
	var mu sync.Mutex
	var saved *MountInfo
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		mu.Lock()
		defer mu.Unlock()
		switch {
		case mountTestMetadata(w, r):
		case r.URL.Path == base && r.Method == http.MethodPost:
			var info MountInfo
			if err := json.NewDecoder(r.Body).Decode(&info); err != nil || info.Target != target {
				t.Errorf("unexpected mount request: %+v, %v", info, err)
				w.WriteHeader(400)
				return
			}
			info.State = MountMounted
			w.WriteHeader(201)
			_ = json.NewEncoder(w).Encode(info)
			// A later lookup sees another state. Add must return its own reply.
			info.State = MountDetaching
			saved = &info
		case r.URL.Path == base && r.Method == http.MethodGet:
			mounts := []MountInfo{}
			if saved != nil {
				mounts = append(mounts, *saved)
			}
			_ = json.NewEncoder(w).Encode(map[string][]MountInfo{"mounts": mounts})
		case r.URL.Path == base+"/by-target" && r.URL.Query().Get("target") == target:
			if r.Method == http.MethodDelete {
				if saved == nil {
					w.WriteHeader(404)
					_, _ = fmt.Fprint(w, `{"error":{"code":"not_found","message":"no mount"}}`)
					return
				}
				saved = nil
				w.WriteHeader(204)
			} else {
				_ = json.NewEncoder(w).Encode(saved)
			}
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	runtime, mount := openTestMount(t, ctx, server.URL)
	defer runtime.Close()
	added, err := mount.Add(ctx, MountRequest{Source: "/host/source", Target: target, ReadOnly: true})
	if err != nil || added != (MountInfo{Source: "/host/source", Target: target, ReadOnly: true, State: MountMounted}) {
		t.Fatalf("Add = %+v, %v", added, err)
	}
	all, err := mount.List(ctx)
	if err != nil || len(all) != 1 || all[0].State != MountDetaching {
		t.Fatalf("List = %+v, %v", all, err)
	}
	got, err := mount.Get(ctx, target)
	if err != nil || got == nil || *got != all[0] {
		t.Fatalf("Get = %+v, %v", got, err)
	}
	if err := mount.Remove(ctx, target); err != nil {
		t.Fatal(err)
	}
	if got, err := mount.Get(ctx, target); got != nil || err != nil {
		t.Fatalf("missing Get = %+v, %v", got, err)
	}
	if err := mount.Remove(ctx, target); !IsNotFound(err) {
		t.Fatalf("missing Remove = %v", err)
	}
}

func TestRuntimeMountsSaveAStoppedAddAsConfigured(t *testing.T) {
	const base = "/v1/boxes/box1/mounts"
	const target = "/workspace"
	request := MountRequest{Source: "/host/source", Target: target, ReadOnly: true}
	want := MountInfo{Source: request.Source, Target: target, ReadOnly: true, State: MountConfigured}
	var mu sync.Mutex
	var saved *MountInfo
	// Requests outside the mount routes, such as one that starts the box.
	var other []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		mu.Lock()
		defer mu.Unlock()
		switch {
		case mountTestMetadataFor(w, r, "stopped"):
		case r.URL.Path == base && r.Method == http.MethodPost:
			var info MountInfo
			if err := json.NewDecoder(r.Body).Decode(&info); err != nil || info.Source != request.Source || info.Target != target || info.ReadOnly != request.ReadOnly {
				t.Errorf("unexpected mount request: %+v, %v", info, err)
				w.WriteHeader(400)
				return
			}
			// The box is stopped, so the mount is saved rather than delivered.
			info.State = MountConfigured
			saved = &info
			w.WriteHeader(201)
			_ = json.NewEncoder(w).Encode(info)
		case r.URL.Path == base && r.Method == http.MethodGet:
			mounts := []MountInfo{}
			if saved != nil {
				mounts = append(mounts, *saved)
			}
			_ = json.NewEncoder(w).Encode(map[string][]MountInfo{"mounts": mounts})
		case r.URL.Path == base+"/by-target" && r.URL.Query().Get("target") == target:
			if r.Method == http.MethodDelete {
				if saved == nil {
					w.WriteHeader(404)
					_, _ = fmt.Fprint(w, `{"error":{"code":"not_found","message":"no mount"}}`)
					return
				}
				saved = nil
				w.WriteHeader(204)
			} else {
				_ = json.NewEncoder(w).Encode(saved)
			}
		default:
			other = append(other, r.Method+" "+r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	runtime, mount := openTestMount(t, ctx, server.URL)
	defer runtime.Close()
	added, err := mount.Add(ctx, request)
	if err != nil || added != want {
		t.Fatalf("Add on a stopped box = %+v, %v; want %+v", added, err, want)
	}
	if all, err := mount.List(ctx); err != nil || len(all) != 1 || all[0] != want {
		t.Fatalf("List = %+v, %v; want the saved %+v", all, err, want)
	}
	if got, err := mount.Get(ctx, target); err != nil || got == nil || *got != want {
		t.Fatalf("Get = %+v, %v; want the saved %+v", got, err, want)
	}
	if err := mount.Remove(ctx, target); err != nil {
		t.Fatal(err)
	}
	if got, err := mount.Get(ctx, target); got != nil || err != nil {
		t.Fatalf("Get after Remove = %+v, %v", got, err)
	}
	// The saved mount was observed and discarded without starting the box.
	mu.Lock()
	defer mu.Unlock()
	for _, route := range other {
		t.Errorf("a mount call sent %s; it must not start the box", route)
	}
}

func TestRuntimeMountsRefuseAddAfterRuntimeStops(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !mountTestMetadata(w, r) {
			t.Errorf("mount request after runtime stopped: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusServiceUnavailable)
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	request := MountRequest{Source: "/host/source", Target: "/workspace"}
	t.Run("Close", func(t *testing.T) {
		runtime, mount := openTestMount(t, ctx, server.URL)
		if err := runtime.Close(); err != nil {
			t.Fatal(err)
		}
		if _, err := mount.Add(ctx, request); !errors.Is(err, ErrRuntimeClosed) {
			t.Fatalf("Add after Close = %v, want ErrRuntimeClosed", err)
		}
	})
	t.Run("Shutdown", func(t *testing.T) {
		runtime, mount := openTestMount(t, ctx, server.URL)
		defer runtime.Close()
		if err := runtime.Shutdown(ctx, time.Second); err != nil {
			t.Fatal(err)
		}
		if _, err := mount.Add(ctx, request); !IsStopped(err) {
			t.Fatalf("Add after Shutdown = %v, want stopped", err)
		}
	})
}

func TestRuntimeMountsReleaseWaitersOnCancelAndClose(t *testing.T) {
	for _, closeRuntime := range []bool{false, true} {
		t.Run(fmt.Sprintf("close_runtime=%v", closeRuntime), func(t *testing.T) {
			arrived := make(chan struct{})
			release := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if mountTestMetadata(w, r) {
					return
				}
				close(arrived)
				<-release
				_, _ = fmt.Fprint(w, `{"mounts":[]}`)
			}))
			defer server.Close()
			deadline, done := context.WithTimeout(context.Background(), 10*time.Second)
			defer done()
			runtime, mount := openTestMount(t, deadline, server.URL)
			var closed chan struct{}
			defer func() {
				close(release)
				if closed == nil {
					_ = runtime.Close()
				} else {
					<-closed
				}
			}()
			ctx, cancel := context.WithCancel(deadline)
			defer cancel()
			result := make(chan error, 1)
			go func() {
				_, err := mount.List(ctx)
				result <- err
			}()
			select {
			case <-arrived:
			case <-deadline.Done():
				t.Fatal("mount list never reached the server")
			}
			var expected error = context.Canceled
			if closeRuntime {
				closed = make(chan struct{})
				go func() {
					_ = runtime.Close()
					close(closed)
				}()
				expected = ErrRuntimeClosed
			} else {
				cancel()
			}
			select {
			case err := <-result:
				if !errors.Is(err, expected) {
					t.Fatalf("List returned %v, want %v", err, expected)
				}
			case <-deadline.Done():
				t.Fatal("mount list waiter was not released")
			}
		})
	}
}

func TestRuntimeMountsRejectUnusablePathsBeforeTheNativeCall(t *testing.T) {
	ctx := context.Background()
	// Without a box, a path that passes validation would report a closed box.
	mount := new(Mount)
	for _, path := range []string{"/bad\x00path", "/bad\xff"} {
		_, source := mount.Add(ctx, MountRequest{Source: path, Target: "/workspace"})
		_, target := mount.Add(ctx, MountRequest{Source: "/host", Target: path})
		_, get := mount.Get(ctx, path)
		for operation, err := range map[string]error{
			"add source": source, "add target": target, "get": get, "remove": mount.Remove(ctx, path),
		} {
			if !IsInvalidArgument(err) {
				t.Errorf("%s(%q) = %v, want invalid argument", operation, path, err)
			}
		}
	}
}

// mountTestMetadata answers the requests a mount call makes besides its own:
// the runtime capabilities and the metadata of a running box1.
func mountTestMetadata(w http.ResponseWriter, r *http.Request) bool {
	return mountTestMetadataFor(w, r, "running")
}

func mountTestMetadataFor(w http.ResponseWriter, r *http.Request, status string) bool {
	switch r.URL.Path {
	case "/v1/config":
		_, _ = fmt.Fprint(w, `{"capabilities":{"runtime_mounts_enabled":true}}`)
	case "/v1/boxes/box1":
		_, _ = fmt.Fprintf(w, `{"box_id":"box1","status":%q,"image":"alpine:latest","cpus":1,"memory_mib":256,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}`, status)
	default:
		return false
	}
	return true
}

func openTestMount(t *testing.T, ctx context.Context, url string) (*Runtime, *Mount) {
	t.Helper()
	runtime, err := NewRest(BoxliteRestOptions{URL: url})
	if err != nil {
		t.Fatal(err)
	}
	box, err := runtime.Get(ctx, "box1")
	if err != nil {
		_ = runtime.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = box.Close() })
	return runtime, box.Mount()
}
