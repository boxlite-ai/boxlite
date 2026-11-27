package boxlite

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func newStartExecutionTestBox(t *testing.T, mux *http.ServeMux) *Box {
	t.Helper()
	mux.HandleFunc("GET /v1/boxes/box1", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"box_id":"box1","name":"box1","status":"running",`+
			`"created_at":"2026-07-14T00:00:00Z","updated_at":"2026-07-14T00:00:00Z",`+
			`"image":"alpine:3.20","cpus":1,"memory_mib":256}`)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	rt, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = rt.Close() })
	box, err := rt.Get(context.Background(), "box1")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = box.Close() })
	return box
}

func TestStartExecutionExpiredContextDoesNotSubmit(t *testing.T) {
	mux := http.NewServeMux()
	var submissions atomic.Int32
	mux.HandleFunc("POST /v1/boxes/box1/exec", func(w http.ResponseWriter, _ *http.Request) {
		submissions.Add(1)
		w.WriteHeader(http.StatusBadRequest)
	})
	box := newStartExecutionTestBox(t, mux)
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()

	execution, err := box.StartExecution(ctx, "true", nil, nil)
	if execution != nil {
		_ = execution.Close()
	}
	if !errors.Is(err, context.DeadlineExceeded) || submissions.Load() != 0 {
		t.Fatalf("StartExecution returned %v after %d launch requests; want deadline exceeded and no launch", err, submissions.Load())
	}
}

func TestStartExecutionCancelWhileSubmitting(t *testing.T) {
	mux := http.NewServeMux()
	submitted := make(chan struct{})
	respond := make(chan struct{})
	releaseResponse := sync.OnceFunc(func() { close(respond) })
	terminated := make(chan struct{}, 1)
	mux.HandleFunc("POST /v1/boxes/box1/exec", func(w http.ResponseWriter, _ *http.Request) {
		close(submitted)
		<-respond
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"execution_id":"exec-1"}`)
	})
	mux.HandleFunc("DELETE /v1/boxes/box1/executions/exec-1", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
		terminated <- struct{}{}
	})
	mux.HandleFunc("GET /v1/boxes/box1/executions/exec-1", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"execution_id":"exec-1","status":"completed","exit_code":137}`)
	})
	box := newStartExecutionTestBox(t, mux)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	defer releaseResponse()

	returned := make(chan error, 1)
	go func() {
		execution, err := box.StartExecution(ctx, "true", nil, nil)
		if execution != nil {
			_ = execution.Close()
		}
		returned <- err
	}()
	select {
	case <-submitted:
	case err := <-returned:
		t.Fatalf("StartExecution returned before submission: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("backend did not receive the launch request")
	}

	cancel()
	select {
	case err := <-returned:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("StartExecution returned %v; want context canceled", err)
		}
	case <-time.After(2 * time.Second):
		releaseResponse()
		select {
		case <-returned:
		case <-time.After(5 * time.Second):
			t.Fatal("StartExecution did not finish after the backend response was released")
		}
		t.Fatal("StartExecution stayed blocked until the backend released its response")
	}

	// Close takes the write lock. The native submission still needs the box
	// handle while the backend response is withheld.
	if box.mu.TryLock() {
		box.mu.Unlock()
		t.Fatal("box handle was unlocked while native submission was pending")
	}
	closed := make(chan error, 1)
	go func() { closed <- box.Close() }()
	releaseResponse()
	select {
	case <-terminated:
	case <-time.After(5 * time.Second):
		t.Fatal("SDK did not send a termination request for the late execution")
	}
	select {
	case err := <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Close did not finish after the native submission returned")
	}
}
