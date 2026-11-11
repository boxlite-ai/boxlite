//go:build unix

package boxlite

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestResizeCrossesFFIAndREST(t *testing.T) {
	requests := make(chan []byte, 2)
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
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			return
		}
		var body struct {
			CPUs      float64 `json:"cpus"`
			MemoryMiB uint32  `json:"memory_mib"`
		}
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Error(err)
			return
		}
		requests <- raw
		if body.CPUs == 1 {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":{"message":"cannot shrink","type":"InvalidArgumentError","code":"invalid_argument"}}`)
			return
		}
		if body.CPUs == 0 {
			_, _ = io.WriteString(w, `{"cpus":0.5,"memory_mib":512,"max_cpus":8,"max_memory_mib":4096}`)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"cpus": body.CPUs, "memory_mib": 512, "max_cpus": 8, "max_memory_mib": 4096})
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
	sent := <-requests
	var sentBody struct {
		CPUs      float64 `json:"cpus"`
		MemoryMiB uint32  `json:"memory_mib"`
	}
	if err := json.Unmarshal(sent, &sentBody); err != nil {
		t.Fatal(err)
	}
	if got := (ResizeOptions{CPUs: sentBody.CPUs, MemoryMiB: sentBody.MemoryMiB}); got != target {
		t.Fatalf("wrong wire target: %+v", got)
	}
	var sentKeys map[string]json.RawMessage
	if err := json.Unmarshal(sent, &sentKeys); err != nil {
		t.Fatal(err)
	}
	if _, ok := sentKeys["memory_mib"]; !ok {
		t.Fatalf("memory_mib missing from full resize: %s", sent)
	}
	if _, err := box.Resize(context.Background(), ResizeOptions{CPUs: 1}); !networkErrorCode(err, ErrInvalidArgument) {
		t.Fatalf("expected shrink error, got %v", err)
	}
	sent = <-requests
	var omittedKeys map[string]json.RawMessage
	if err := json.Unmarshal(sent, &omittedKeys); err != nil {
		t.Fatal(err)
	}
	if _, ok := omittedKeys["memory_mib"]; ok {
		t.Fatalf("memory was not omitted: %s", sent)
	}
	if _, ok := omittedKeys["cpus"]; !ok {
		t.Fatalf("cpus missing from resize: %s", sent)
	}
	for _, opts := range []ResizeOptions{{}, {MemoryMiB: 512}} {
		got, err := box.Resize(context.Background(), opts)
		if err != nil || got.CPUs != 0.5 || got.MemoryMiB != 512 {
			t.Fatalf("fractional response lost across FFI: resources=%+v error=%v", got, err)
		}
		var body map[string]json.RawMessage
		if err := json.Unmarshal(<-requests, &body); err != nil {
			t.Fatal(err)
		}
		if _, present := body["cpus"]; present {
			t.Fatalf("omitted CPU target was sent: %v", body)
		}
		if _, present := body["memory_mib"]; present != (opts.MemoryMiB != 0) {
			t.Fatalf("memory target presence changed: %v", body)
		}
	}
	for _, cpus := range []float64{0.125, 0.75, 1.5, 2.5} {
		got, err := box.Resize(context.Background(), ResizeOptions{CPUs: cpus})
		if err != nil || got.CPUs != cpus {
			t.Fatalf("fractional target lost: %+v %v", got, err)
		}
		var body map[string]any
		if err := json.Unmarshal(<-requests, &body); err != nil {
			t.Fatal(err)
		}
		if body["cpus"] != cpus || len(body) != 1 {
			t.Fatalf("unexpected fractional request: %v", body)
		}
	}
	for _, cpus := range []float64{-1, 0.124, 0.1251, 256, math.NaN(), math.Inf(1)} {
		if _, err := box.Resize(context.Background(), ResizeOptions{CPUs: cpus}); !networkErrorCode(err, ErrInvalidArgument) {
			t.Fatalf("invalid CPU %v accepted: %v", cpus, err)
		}
	}
	if len(requests) != 0 {
		t.Fatal("invalid targets reached the server")
	}
}
