//go:build unix

package boxlite

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestResizeCrossesFFIAndREST(t *testing.T) {
	requests := make(chan ResizeOptions, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet && r.URL.Path == "/v1/boxes/box1" {
			_, _ = io.WriteString(w, `{"box_id":"box1","status":"running","created_at":"2026-07-14T00:00:00Z","updated_at":"2026-07-14T00:00:00Z","image":"alpine","cpus":1,"memory_mib":256}`)
			return
		}
		if r.Method != http.MethodPost || r.URL.Path != "/v1/boxes/box1/resize" {
			http.NotFound(w, r)
			return
		}
		var body struct {
			CPUs      uint8  `json:"cpus"`
			MemoryMiB uint32 `json:"memory_mib"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		requests <- ResizeOptions{CPUs: body.CPUs, MemoryMiB: body.MemoryMiB}
		if body.CPUs == 1 {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":{"message":"cannot shrink","type":"InvalidArgumentError","code":"invalid_argument"}}`)
			return
		}
		_, _ = io.WriteString(w, `{"cpus":2,"memory_mib":512,"max_cpus":8,"max_memory_mib":4096}`)
	}))
	defer server.Close()
	rt, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	box, err := rt.Get(context.Background(), "box1")
	if err != nil {
		t.Fatal(err)
	}
	defer box.Close()
	target := ResizeOptions{CPUs: 2, MemoryMiB: 512}
	got, err := box.Resize(context.Background(), target)
	if err != nil {
		t.Fatal(err)
	}
	if *got != (BoxResources{CPUs: 2, MemoryMiB: 512, MaxCPUs: 8, MaxMemoryMiB: 4096}) {
		t.Fatalf("wrong callback resources: %+v", got)
	}
	if sent := <-requests; sent != target {
		t.Fatalf("wrong wire target: %+v", sent)
	}
	if _, err := box.Resize(context.Background(), ResizeOptions{CPUs: 1}); !networkErrorCode(err, ErrInvalidArgument) {
		t.Fatalf("expected shrink error, got %v", err)
	}
	if sent := <-requests; sent.MemoryMiB != 0 {
		t.Fatalf("memory was not omitted: %+v", sent)
	}
}
