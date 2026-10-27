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
	"testing"
	"time"
)

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
