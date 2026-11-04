package boxlite

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSnapshotLateResultCleanupPreservesAcceptedChild(t *testing.T) {
	var deleted atomic.Bool
	var stopped atomic.Bool
	entered := make(chan struct{})
	release := make(chan struct{})
	started := make(chan struct{}, 1)
	removed := make(chan string, 2)
	var releaseOnce sync.Once
	releaseResponse := func() { releaseOnce.Do(func() { close(release) }) }
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/v1/config":
			fmt.Fprint(w, `{"capabilities":{"create_from_snapshot_enabled":true}}`)
		case r.Method == http.MethodDelete:
			deleted.Store(true)
			removed <- "DELETE"
			w.WriteHeader(204)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/stop"):
			stopped.Store(true)
			removed <- "STOP"
			w.WriteHeader(204)
		case deleted.Load():
			w.WriteHeader(404)
			fmt.Fprint(w, `{"message":"deleted"}`)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/snapshots/saved/boxes"):
			close(entered)
			<-release
			w.WriteHeader(http.StatusCreated)
			fmt.Fprint(w, `{"box_id":"child","status":"configured","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","image":"base","cpus":2,"memory_mib":512}`)
		case stopped.Load():
			fmt.Fprint(w, `{"box_id":"child","status":"stopped","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","image":"base","cpus":2,"memory_mib":512}`)
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/boxes/child"):
			fmt.Fprint(w, `{"box_id":"child","status":"running","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","image":"base","cpus":2,"memory_mib":512}`)
			select {
			case started <- struct{}{}:
			default:
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	rt, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	defer releaseResponse()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		child, err := rt.CreateFromSnapshot(ctx, "saved")
		if child != nil {
			child.Close()
		}
		result <- err
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("snapshot POST never arrived")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled create = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("create did not return before the late response")
	}
	releaseResponse()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("late child did not finish native startup")
	}
	// A negative request assertion has a bounded observation window, after
	// actual native startup; keep the runtime alive to allow late cleanup.
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	select {
	case operation := <-removed:
		t.Fatalf("cancelled snapshot wait triggered %s on the accepted child", operation)
	case <-timer.C:
	}
	if _, err := rt.GetInfo(context.Background(), "child"); err != nil {
		t.Fatalf("late snapshot cleanup removed the accepted child: %v", err)
	}
}

func TestSnapshotCloudBindings(t *testing.T) {
	var mu sync.Mutex
	var requests []string
	boxJSON := func(id, status string) string {
		return fmt.Sprintf(`{"box_id":%q,"name":"cozy-otter","status":%q,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","image":"base","cpus":2,"memory_mib":512}`, id, status)
	}
	info := `{"id":"snap-1","box_id":"source","name":"saved","created_at":1,"container_disk_bytes":1024,"size_bytes":256,"status":"ready"}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		route := r.Method + " " + r.URL.Path
		mu.Lock()
		requests = append(requests, route)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch route {
		case "GET /v1/config":
			fmt.Fprint(w, `{"capabilities":{"snapshots_enabled":true,"create_from_snapshot_enabled":true}}`)
		case "GET /v1/acme/boxes/source":
			fmt.Fprint(w, boxJSON("source", "stopped"))
		case "POST /v1/acme/boxes/source/snapshots":
			w.WriteHeader(201)
			fmt.Fprint(w, strings.Replace(info, `"ready"`, `"creating"`, 1))
		case "GET /v1/acme/boxes/source/snapshots/saved", "GET /v1/acme/snapshots/saved":
			fmt.Fprint(w, info)
		case "GET /v1/acme/boxes/source/snapshots", "GET /v1/acme/snapshots":
			fmt.Fprintf(w, `{"snapshots":[%s]}`, info)
		case "POST /v1/acme/snapshots/saved/boxes":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			opts, _ := body["options"].(map[string]any)
			if _, ok := opts["image"]; ok {
				t.Error("snapshot request carried an image")
			}
			if opts["cpus"] != float64(2) {
				t.Errorf("CPU options lost: %v", body)
			}
			w.WriteHeader(201)
			fmt.Fprint(w, boxJSON("child", "configured"))
		case "GET /v1/acme/boxes/child":
			fmt.Fprint(w, boxJSON("child", "running"))
		case "POST /v1/acme/boxes/source/snapshots/saved/restore":
			w.WriteHeader(202)
			fmt.Fprint(w, `{"id":"restore-1","status":"pending"}`)
		case "GET /v1/acme/boxes/source/restores/restore-1":
			fmt.Fprint(w, `{"id":"restore-1","status":"succeeded"}`)
		case "DELETE /v1/acme/snapshots/saved", "DELETE /v1/acme/boxes/source/snapshots/saved":
			w.WriteHeader(204)
		case "DELETE /v1/acme/snapshots/protected":
			w.WriteHeader(403)
			fmt.Fprint(w, `{"message":"permission denied"}`)
		default:
			w.WriteHeader(404)
			fmt.Fprint(w, `{"error":{"message":"gone","error_type":"NotFoundError","code":"not_found"}}`)
		}
	}))
	defer server.Close()
	rt, err := NewRest(BoxliteRestOptions{URL: server.URL, PathPrefix: "acme"})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	bx, err := rt.Get(ctx, "source")
	if err != nil {
		t.Fatal(err)
	}
	defer bx.Close()
	snapshots, err := bx.Snapshots()
	if err != nil {
		t.Fatal(err)
	}
	defer snapshots.Close()
	snap, err := snapshots.Create(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	if snap.Id != "snap-1" || snap.Status != "ready" || snap.BoxId != "source" || snap.SizeBytes != 256 {
		t.Fatalf("metadata: %+v", snap)
	}
	list, err := snapshots.List(ctx)
	if err != nil || len(list) != 1 {
		t.Fatalf("list: %v %v", list, err)
	}
	missing, err := snapshots.Get(ctx, "missing")
	if err != nil || missing != nil {
		t.Fatalf("box missing: %v %v", missing, err)
	}
	catalog, err := rt.Snapshots()
	if err != nil {
		t.Fatal(err)
	}
	defer catalog.Close()
	for label, operation := range map[string]func() error{
		"get":     func() error { _, err := catalog.Get(ctx, "saved\x00-suffix"); return err },
		"remove":  func() error { return catalog.Remove(ctx, "saved\x00-suffix", false) },
		"restore": func() error { return snapshots.Restore(ctx, "saved\x00-suffix") },
		"capture": func() error { _, err := snapshots.Create(ctx, "saved\x00-suffix"); return err },
		"child": func() error {
			child, err := rt.CreateFromSnapshot(ctx, "saved\x00-suffix", WithCPUs(2))
			if child != nil {
				child.Close()
			}
			return err
		},
	} {
		t.Run("NUL-"+label, func(t *testing.T) {
			var invalid *Error
			if err := operation(); !errors.As(err, &invalid) || invalid.Code != ErrInvalidArgument {
				t.Errorf("expected invalid argument before FFI truncation, got %v", err)
			}
		})
	}
	list, err = catalog.List(ctx)
	if err != nil || len(list) != 1 {
		t.Fatalf("catalog: %v %v", list, err)
	}
	snap, err = catalog.Get(ctx, "saved")
	if err != nil || snap.CreatedAt != 1 {
		t.Fatalf("get: %v %v", snap, err)
	}
	if _, err = catalog.Get(ctx, "missing"); err == nil {
		t.Fatal("missing organization snapshot must error")
	}
	if _, err = catalog.Create(ctx, "bad"); err == nil {
		t.Fatal("organization capture must fail")
	}
	child, err := rt.CreateFromSnapshot(ctx, "saved", WithCPUs(2))
	if err != nil {
		t.Fatal(err)
	}
	defer child.Close()
	if child.ID() != "child" || child.Name() != "cozy-otter" {
		t.Fatalf("child: %s %s", child.ID(), child.Name())
	}
	if err = snapshots.Restore(ctx, "saved"); err != nil {
		t.Fatal(err)
	}
	if err = catalog.Remove(ctx, "missing", true); err != nil {
		t.Fatal(err)
	}
	if err = catalog.Remove(ctx, "protected", true); err == nil {
		t.Fatal("force swallowed permission error")
	}
	if err = catalog.Remove(ctx, "saved", false); err != nil {
		t.Fatal(err)
	}
	if err = snapshots.Remove(ctx, "saved", false); err != nil {
		t.Fatal(err)
	}
	snapshots.Close()
	if _, err = snapshots.List(ctx); err == nil {
		t.Fatal("closed handle remained usable")
	}
	mu.Lock()
	defer mu.Unlock()
	posts := 0
	for _, r := range requests {
		if r == "POST /v1/acme/snapshots/saved/boxes" {
			posts++
		}
	}
	if posts != 1 {
		t.Fatalf("creation posted %d times", posts)
	}
}

func TestSnapshotCancellationAndRuntimeClose(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/config" {
			fmt.Fprint(w, `{"capabilities":{"snapshots_enabled":true}}`)
			return
		}
		close(entered)
		<-release
		fmt.Fprint(w, `{"snapshots":[]}`)
	}))
	defer server.Close()
	rt, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	snapshots, err := rt.Snapshots()
	if err != nil {
		t.Fatal(err)
	}
	defer snapshots.Close()
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { _, err := snapshots.List(ctx); result <- err }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		close(release)
		cancel()
		rt.Close()
		t.Fatal("request did not reach server")
	}
	cancel()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
	close(release)
	if err := rt.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := snapshots.List(context.Background()); err == nil {
		t.Fatal("closed runtime accepted work")
	}
}

func snapshotOperations(handle *Snapshots) map[string]func(context.Context) error {
	return map[string]func(context.Context) error{
		"create":  func(ctx context.Context) error { _, err := handle.Create(ctx, "saved"); return err },
		"list":    func(ctx context.Context) error { _, err := handle.List(ctx); return err },
		"get":     func(ctx context.Context) error { _, err := handle.Get(ctx, "saved"); return err },
		"remove":  func(ctx context.Context) error { return handle.Remove(ctx, "saved", false) },
		"restore": func(ctx context.Context) error { return handle.Restore(ctx, "saved") },
	}
}

func TestSnapshotNilAndClosedHandles(t *testing.T) {
	for label, handle := range map[string]*Snapshots{"nil": nil, "zero": {}} {
		for operation, invoke := range snapshotOperations(handle) {
			t.Run(label+"/"+operation, func(t *testing.T) {
				var invalid *Error
				if err := invoke(context.Background()); !errors.As(err, &invalid) || invalid.Code != ErrInvalidState {
					t.Fatalf("closed snapshot operation = %v", err)
				}
			})
		}
		if err := handle.Close(); err != nil {
			t.Fatal(err)
		}
	}
	for _, box := range []*Box{nil, {}} {
		if _, err := box.Snapshots(); err == nil {
			t.Fatal("closed box accepted a snapshot accessor")
		}
	}
	rt, err := NewRest(BoxliteRestOptions{URL: "http://127.0.0.1:1"})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	handle, err := rt.Snapshots()
	if err != nil {
		t.Fatal(err)
	}
	if err := handle.Close(); err != nil {
		t.Fatal(err)
	}
	for operation, invoke := range snapshotOperations(handle) {
		if err := invoke(context.Background()); err == nil {
			t.Fatalf("%s accepted a closed handle", operation)
		}
	}
}

func TestSnapshotValidationAndNativeFailures(t *testing.T) {
	t.Setenv("NO_PROXY", "127.0.0.1,localhost")
	var mutations atomic.Int32
	var lists atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/config" {
			fmt.Fprint(w, `{"capabilities":{"snapshots_enabled":true,"create_from_snapshot_enabled":true}}`)
			return
		}
		if r.Method == http.MethodPost {
			mutations.Add(1)
		}
		if r.URL.Path == "/v1/snapshots" && lists.Add(1) == 1 {
			fmt.Fprint(w, `{"snapshots":[]}`)
			return
		}
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, `{"message":"snapshot access denied"}`)
	}))
	defer server.Close()
	rt, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	for _, option := range []BoxOption{WithRootfsPath(t.TempDir()), WithNetwork(NetworkSpec{Outbound: OutboundNetworkSpec{Mode: "invalid"}})} {
		if child, err := rt.CreateFromSnapshot(context.Background(), "saved", option); err == nil || child != nil {
			t.Fatalf("invalid snapshot child options = %v, %v", child, err)
		}
	}
	if mutations.Load() != 0 {
		t.Fatal("invalid child options reached the HTTP creation boundary")
	}
	catalog, err := rt.Snapshots()
	if err != nil {
		t.Fatal(err)
	}
	defer catalog.Close()
	if snapshots, err := catalog.List(context.Background()); err != nil || len(snapshots) != 0 {
		t.Fatalf("empty native snapshot catalog = %v, %v", snapshots, err)
	}
	if _, err := catalog.List(context.Background()); err == nil {
		t.Fatal("snapshot list swallowed a native permission error")
	}
	if child, err := rt.CreateFromSnapshot(context.Background(), "saved"); err == nil || child != nil {
		t.Fatalf("denied snapshot child = %v, %v", child, err)
	}
	if mutations.Load() != 1 {
		t.Fatalf("child creation submitted %d requests", mutations.Load())
	}
	if err := rt.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := rt.Snapshots(); err == nil {
		t.Fatal("closed native runtime accepted a snapshot catalog")
	}
	if child, err := rt.CreateFromSnapshot(context.Background(), "saved"); err == nil || child != nil {
		t.Fatalf("closed native runtime accepted a snapshot child: %v, %v", child, err)
	}
}

func TestSnapshotEveryOperationStopsWaitingOnCancellationOrRuntimeClose(t *testing.T) {
	t.Setenv("NO_PROXY", "127.0.0.1,localhost")
	for _, operation := range []string{"create", "list", "get", "remove", "restore"} {
		for _, shutdown := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/close-%v", operation, shutdown), func(t *testing.T) {
				entered := make(chan struct{})
				release := make(chan struct{})
				var enteredOnce, releaseOnce sync.Once
				unblock := func() { releaseOnce.Do(func() { close(release) }) }
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					switch r.URL.Path {
					case "/v1/config":
						fmt.Fprint(w, `{"capabilities":{"snapshots_enabled":true}}`)
						return
					case "/v1/boxes/source":
						fmt.Fprint(w, `{"box_id":"source","status":"stopped","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","image":"base","cpus":2,"memory_mib":512}`)
						return
					}
					enteredOnce.Do(func() { close(entered) })
					<-release
					switch operation {
					case "list":
						fmt.Fprint(w, `{"snapshots":[]}`)
					case "restore":
						fmt.Fprint(w, `{"id":"restore-1","status":"succeeded"}`)
					case "remove":
						w.WriteHeader(http.StatusNoContent)
					default:
						fmt.Fprint(w, `{"id":"saved","box_id":"source","name":"saved","status":"ready","created_at":1,"container_disk_bytes":1024,"size_bytes":256}`)
					}
				}))
				defer server.Close()
				rt, err := NewRest(BoxliteRestOptions{URL: server.URL})
				if err != nil {
					t.Fatal(err)
				}
				var box *Box
				var handle *Snapshots
				defer func() {
					unblock()
					if handle != nil {
						handle.Close()
					}
					if box != nil {
						box.Close()
					}
					rt.Close()
				}()
				box, err = rt.Get(context.Background(), "source")
				if err != nil {
					t.Fatal(err)
				}
				handle, err = box.Snapshots()
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				result := make(chan error, 1)
				go func() { result <- snapshotOperations(handle)[operation](ctx) }()
				select {
				case <-entered:
				case err := <-result:
					t.Fatalf("snapshot operation returned before its HTTP request: %v", err)
				case <-time.After(5 * time.Second):
					t.Fatal("snapshot operation did not reach native HTTP boundary")
				}
				var want error = context.Canceled
				if shutdown {
					want = ErrRuntimeClosed
					if err := rt.Close(); err != nil {
						t.Fatal(err)
					}
				} else {
					cancel()
				}
				select {
				case err := <-result:
					if !errors.Is(err, want) {
						t.Fatalf("wait returned %v, want %v", err, want)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("snapshot waiter remained blocked behind native HTTP")
				}
				unblock()
				if shutdown {
					for _, invoke := range snapshotOperations(handle) {
						var stopped *Error
						if err := invoke(context.Background()); !errors.As(err, &stopped) || stopped.Code != ErrStopped {
							t.Fatalf("closed native runtime returned %v", err)
						}
					}
				}
			})
		}
	}
}
