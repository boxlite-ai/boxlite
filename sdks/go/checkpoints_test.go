package boxlite

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestCheckpointBindingsAndPausedRestore(t *testing.T) {
	const info = `{"id":"cp-1","box_id":"source","name":"saved","status":"ready","created_at":9223372036854775000,"cpus":128,"memory_bytes":18446744073709551615,"container_disk_bytes":4294967296,"size_bytes":18446744073709551614}`
	boxJSON := func(id, status string) string {
		return fmt.Sprintf(`{"box_id":%q,"name":"restored-name","status":%q,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","image":"base","cpus":2,"memory_mib":512}`, id, status)
	}
	var mu sync.Mutex
	var posts []map[string]any
	var pauseBodies []map[string]any
	restores := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer checkpoint-test-key" {
			t.Errorf("missing authentication: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		route := r.Method + " " + r.URL.Path
		switch route {
		case "GET /v1/config":
			fmt.Fprint(w, `{"capabilities":{"checkpoints_enabled":true,"checkpoint_management_enabled":true}}`)
		case "GET /v1/acme/boxes/source":
			fmt.Fprint(w, boxJSON("source", "paused"))
		case "POST /v1/acme/boxes/source/pause":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			mu.Lock()
			pauseBodies = append(pauseBodies, body)
			mu.Unlock()
			fmt.Fprint(w, `{}`)
		case "POST /v1/acme/boxes/source/resume":
			fmt.Fprint(w, `{}`)
		case "POST /v1/acme/boxes/source/checkpoints":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			mu.Lock()
			posts = append(posts, body)
			mu.Unlock()
			w.WriteHeader(201)
			fmt.Fprint(w, strings.Replace(info, `"ready"`, `"creating"`, 1))
		case "GET /v1/acme/boxes/source/checkpoints/cp-1", "GET /v1/acme/boxes/source/checkpoints/saved", "GET /v1/acme/checkpoints/saved":
			fmt.Fprint(w, info)
		case "GET /v1/acme/boxes/source/checkpoints", "GET /v1/acme/checkpoints":
			fmt.Fprintf(w, `{"checkpoints":[%s]}`, info)
		case "POST /v1/acme/checkpoints/saved/boxes":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if len(body) != 1 || body["name"] != "child" {
				t.Errorf("restore changed captured config: %v", body)
			}
			mu.Lock()
			restores++
			mu.Unlock()
			w.WriteHeader(201)
			fmt.Fprint(w, boxJSON("child", "restoring"))
		case "GET /v1/acme/boxes/child":
			fmt.Fprint(w, boxJSON("child", "paused"))
		case "DELETE /v1/acme/checkpoints/saved", "DELETE /v1/acme/boxes/source/checkpoints/saved":
			w.WriteHeader(204)
		case "DELETE /v1/acme/checkpoints/protected":
			w.WriteHeader(403)
			fmt.Fprint(w, `{"error":{"message":"denied","type":"InvalidStateError","code":"invalid_state"}}`)
		default:
			w.WriteHeader(404)
			fmt.Fprint(w, `{"error":{"message":"missing","type":"NotFoundError","code":"not_found"}}`)
		}
	}))
	defer server.Close()
	rt, err := NewRest(BoxliteRestOptions{URL: server.URL, PathPrefix: "acme", Credential: NewApiKeyCredential("checkpoint-test-key")})
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
	if err = bx.Pause(ctx, PauseOptions{}); err != nil {
		t.Fatal(err)
	}
	if err = bx.Pause(ctx, PauseOptions{HostWritersStopped: true}); err != nil {
		t.Fatal(err)
	}
	if err = bx.Resume(ctx); err != nil {
		t.Fatal(err)
	}
	cp, err := bx.Checkpoints()
	if err != nil {
		t.Fatal(err)
	}
	defer cp.Close()
	for _, name := range []string{"", "named"} {
		got, err := cp.Create(ctx, name)
		if err != nil {
			t.Fatal(err)
		}
		if got.CPUs != 128 || got.MemoryBytes != ^uint64(0) || got.SizeBytes != ^uint64(0)-1 || got.CreatedAt != 9223372036854775000 || got.Status != "ready" {
			t.Fatalf("metadata lost: %+v", got)
		}
	}
	if _, err = cp.Create(ctx, " "); err == nil {
		t.Fatal("explicit whitespace name accepted")
	}
	if _, err = cp.Get(ctx, "bad\x00suffix"); err == nil {
		t.Fatal("NUL identifier truncated")
	}
	list, err := cp.List(ctx)
	if err != nil || len(list) != 1 {
		t.Fatalf("list %v %v", list, err)
	}
	got, err := cp.Get(ctx, "missing")
	if err != nil || got != nil {
		t.Fatalf("scoped absence: %v %v", got, err)
	}
	catalog, err := rt.Checkpoints()
	if err != nil {
		t.Fatal(err)
	}
	defer catalog.Close()
	if _, err = catalog.Create(ctx, "bad"); err == nil {
		t.Fatal("root capture accepted")
	}
	if _, err = catalog.Get(ctx, "missing"); err == nil {
		t.Fatal("root absence not an error")
	}
	if _, err = catalog.Get(ctx, "saved"); err != nil {
		t.Fatal(err)
	}
	if list, err = catalog.List(ctx); err != nil || len(list) != 1 {
		t.Fatalf("catalog: %v %v", list, err)
	}
	child, err := rt.CreateFromCheckpoint(ctx, "saved", "child")
	if err != nil {
		t.Fatal(err)
	}
	defer child.Close()
	if child.ID() != "child" || child.Name() != "restored-name" {
		t.Fatalf("box %s %s", child.ID(), child.Name())
	}
	if err = catalog.Remove(ctx, "missing", true); err != nil {
		t.Fatal(err)
	}
	if err = catalog.Remove(ctx, "protected", true); err == nil {
		t.Fatal("force suppressed permission error")
	}
	if err = catalog.Remove(ctx, "saved", false); err != nil {
		t.Fatal(err)
	}
	if err = cp.Remove(ctx, "saved", false); err != nil {
		t.Fatal(err)
	}
	cp.Close()
	if _, err = cp.List(ctx); err == nil {
		t.Fatal("closed catalog accepted work")
	}
	mu.Lock()
	defer mu.Unlock()
	if restores != 1 {
		t.Fatalf("restore retried %d times", restores)
	}
	if len(posts) != 2 || len(posts[0]) != 0 || posts[1]["name"] != "named" {
		t.Fatalf("omitted/nondefault name: %v", posts)
	}
	if len(pauseBodies) != 2 || pauseBodies[0]["host_writers_stopped"] != false || pauseBodies[1]["host_writers_stopped"] != true {
		t.Fatalf("pause options: %v", pauseBodies)
	}
}

func TestCheckpointCapabilityRefusal(t *testing.T) {
	calls := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/config" {
			fmt.Fprint(w, `{"capabilities":{}}`)
			return
		}
		calls++
		t.Errorf("submitted without capability: %s", r.URL.Path)
	}))
	defer s.Close()
	rt, err := NewRest(BoxliteRestOptions{URL: s.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	cp, err := rt.Checkpoints()
	if err != nil {
		t.Fatal(err)
	}
	defer cp.Close()
	if _, err = cp.List(context.Background()); err == nil {
		t.Fatal("old server accepted")
	}
	if _, err = rt.CreateFromCheckpoint(context.Background(), "saved", ""); err == nil {
		t.Fatal("old server restore accepted")
	}
	if calls != 0 {
		t.Fatal("unsupported submitted")
	}
}

func TestCheckpointNativeErrorCategories(t *testing.T) {
	path := t.TempDir()
	for _, name := range []string{"snapshot.mem", "snapshot.qcow2"} {
		if err := os.WriteFile(filepath.Join(path, name), []byte("corrupt"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	_, cloudErr := InspectCloudUpload(path)
	_, legacyErr := InspectCheckpoint(path)
	var cloud, legacy *Error
	if !errors.As(cloudErr, &cloud) || cloud.Code != ErrInvalidArgument {
		t.Fatalf("cloud input category: %v", cloudErr)
	}
	if !errors.As(legacyErr, &legacy) || legacy.Code != ErrStorage {
		t.Fatalf("legacy category: %v", legacyErr)
	}
	_, ioErr := InspectCloudUpload(filepath.Join(path, "absent"))
	var ioFailure *Error
	if !errors.As(ioErr, &ioFailure) || ioFailure.Code != ErrStorage {
		t.Fatalf("OS read category: %v", ioErr)
	}
	if _, err := InspectCloudUpload("bad\x00path"); err == nil {
		t.Fatal("NUL path accepted")
	}
}

func TestCheckpointCancellationRetainsCompletion(t *testing.T) {
	baseline := map[any]struct{}{}
	activeHandles.Range(func(key, value any) bool { baseline[key] = struct{}{}; return true })
	entered := make(chan struct{})
	release := make(chan struct{})
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/config" {
			fmt.Fprint(w, `{"capabilities":{"checkpoint_management_enabled":true}}`)
			return
		}
		close(entered)
		<-release
		fmt.Fprint(w, `{"checkpoints":[]}`)
	}))
	defer s.Close()
	rt, err := NewRest(BoxliteRestOptions{URL: s.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	cp, err := rt.Checkpoints()
	if err != nil {
		t.Fatal(err)
	}
	defer cp.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := cp.List(ctx); done <- err }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		close(release)
		t.Fatal("request did not reach native HTTP client")
	}
	cancel()
	if err = <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
	close(release)
	deadline := time.Now().Add(5 * time.Second)
	for {
		pending := false
		activeHandles.Range(func(key, value any) bool {
			if _, ok := baseline[key]; !ok {
				pending = true
			}
			return true
		})
		if !pending {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("cancelled native completion leaked its dispatch handle")
		}
		time.Sleep(time.Millisecond)
	}
	if err = rt.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = cp.List(context.Background()); err == nil {
		t.Fatal("closed runtime accepted work")
	}
}

func TestCheckpointNativeRegistrationAndTransportErrors(t *testing.T) {
	rt, err := NewRuntime(WithHomeDir(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	ctx := context.Background()
	invalidPair := t.TempDir()
	for _, name := range []string{"snapshot.mem", "snapshot.qcow2"} {
		if err := os.WriteFile(filepath.Join(invalidPair, name), []byte("corrupt"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	options := CloudCheckpointImportOptions{OperationID: "05d39b87-c010-4498-ac02-95448ea27572", ExpectedPairSHA256: strings.Repeat("0", 64)}
	_, err = rt.ImportCheckpointPair(ctx, invalidPair, options)
	var native *Error
	if !errors.As(err, &native) || native.Code != ErrInvalidArgument {
		t.Fatalf("registered malformed pair: %v", err)
	}
	_, err = rt.ImportCheckpointPair(ctx, filepath.Join(invalidPair, "missing"), options)
	if !errors.As(err, &native) || native.Code != ErrStorage {
		t.Fatalf("registration OS failure category: %v", err)
	}
	_, err = rt.ImportCheckpointArchive(ctx, filepath.Join(invalidPair, "missing.zst"), options.OperationID)
	if !errors.As(err, &native) || native.Code != ErrStorage {
		t.Fatalf("archive OS failure category: %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/config" {
			t.Errorf("invalid caller-local pair was uploaded: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"capabilities":{"checkpoints_enabled":true}}`)
	}))
	defer server.Close()
	remote, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer remote.Close()
	if _, err = remote.ImportCheckpoint(ctx, invalidPair, CheckpointImportOptions{}); !errors.As(err, &native) || native.Code != ErrStorage {
		t.Fatalf("legacy caller-local pair category: %v", err)
	}
	catalog, err := rt.Checkpoints()
	if err != nil {
		t.Fatal(err)
	}
	defer catalog.Close()
	list, err := catalog.List(ctx)
	if err != nil || len(list) != 0 {
		t.Fatalf("failed registration published a resource: %v %v", list, err)
	}
	if err = rt.ExportCheckpointArchive(ctx, "missing", filepath.Join(invalidPair, "out.zst")); !errors.As(err, &native) || native.Code != ErrNotFound {
		t.Fatalf("missing archive resource: %v", err)
	}
	if _, err = rt.CreateFromCheckpointWithOperation(ctx, "missing", "target", options.OperationID); !errors.As(err, &native) || native.Code != ErrNotFound {
		t.Fatalf("missing operation restore resource: %v", err)
	}
}
