//go:build boxlite_dev

package boxlite

// Regression tests for BUI-1723 (GHSA-6298-9294-9pmg): Box.Close freed the
// native handle while another goroutine was passing it into the C ABI.
//
// The tests drive a REST-backed runtime because the REST path crosses the
// real CGO boundary into the native library on every call, so -race sees the
// actual handle free versus use. Run with: make test:unit:go RACE=1

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// newRaceTestBox serves one box over REST and returns the runtime and the
// live box handle handed out by Get.
func newRaceTestBox(t *testing.T) (*Runtime, *Box) {
	t.Helper()
	mux := http.NewServeMux()
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	mux.HandleFunc("/v1/boxes/box1", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"box_id":"box1","name":"svc","status":"running",`+
			`"created_at":"2026-07-14T00:00:00Z","updated_at":"2026-07-14T00:00:00Z",`+
			`"pid":null,"image":"alpine:3.20","cpus":1,"memory_mib":256}`)
	})
	mux.HandleFunc("/v1/boxes/box1/metrics", func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Millisecond) // widen the in-flight window
		_, _ = io.WriteString(w, `{"commands_executed_total":1,"cpu_percent":1.5,"memory_bytes":1024}`)
	})

	rt, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatalf("NewRest: %v", err)
	}
	t.Cleanup(func() { _ = rt.Close() })

	box, err := rt.Get(context.Background(), "box1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	return rt, box
}

// TestBoxCloseConcurrentWithMethods hammers Metrics, Info and Name against
// concurrent Closes. On the unfixed code -race reports a DATA RACE between
// Box.Close's handle store and Box.Metrics's handle read; after the fix the
// guard serializes handle use against Close and the test is clean.
func TestBoxCloseConcurrentWithMethods(t *testing.T) {
	_, box := newRaceTestBox(t)

	const readers, closers, iters = 8, 4, 200
	var wg sync.WaitGroup
	for range readers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range iters {
				_, _ = box.Metrics(context.Background())
				_, _ = box.Info(context.Background())
				_ = box.Name()
			}
		}()
	}
	for range closers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range iters {
				// Repeat Close inside the race: a double free is the
				// sibling defect of free-while-in-use.
				_ = box.Close()
				_ = box.Close()
			}
		}()
	}
	wg.Wait()
}

// TestBoxMethodsAfterCloseReturnInvalidState pins the closed-box contract:
// every method either fails before any native call with ErrInvalidState.
func TestBoxMethodsAfterCloseReturnInvalidState(t *testing.T) {
	_, box := newRaceTestBox(t)
	if err := box.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	ctx := context.Background()
	checks := map[string]func() error{
		"Metrics":        func() error { _, err := box.Metrics(ctx); return err },
		"Info":           func() error { _, err := box.Info(ctx); return err },
		"Start":          func() error { return box.Start(ctx) },
		"Stop":           func() error { return box.Stop(ctx) },
		"ExecutionsList": func() error { _, err := box.Executions().List(ctx); return err },
		"Network":        func() error { _, err := box.Network(); return err },
		"SSHStatus":      func() error { _, err := box.SSH().Status(ctx); return err },
		"Export":         func() error { _, err := box.Export(ctx, "/tmp/boxlite-closed-export"); return err },
		"StartExecution": func() error { _, err := box.StartExecution(ctx, "true", nil, nil); return err },
	}
	for name, call := range checks {
		if err := call(); !IsInvalidState(err) {
			t.Errorf("%s after Close: got %v, want ErrInvalidState", name, err)
		}
	}
}

// TestBoxCloseIsIdempotent: repeat Close must stay a no-op, not a double free.
func TestBoxCloseIsIdempotent(t *testing.T) {
	_, box := newRaceTestBox(t)
	if err := box.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err := box.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}
