//go:build boxlite_dev

// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
)

// BUI-1723 regression at the runner level: Destroy's cache step
// (forgetBox -> Box.Close) racing BoxMetrics (getOrFetchBox -> Box.Metrics)
// used to free the native handle out from under the metrics call and crash
// the process. The SDK now serializes handle use against Close; this pins
// the runner side of the contract — the cache is dropped without holding the
// global lock across the close, and cache removal coexists with concurrent
// reads under -race.
func TestForgetBoxRacingBoxMetricsStaysConsistent(t *testing.T) {
	mux := http.NewServeMux()
	server := httptest.NewServer(mux)
	defer server.Close()

	mux.HandleFunc("/v1/boxes/b1", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"box_id":"b1","name":null,"status":"running",`+
			`"created_at":"2026-11-04T00:00:00Z","updated_at":"2026-11-04T00:00:00Z",`+
			`"pid":null,"image":"alpine:latest","cpus":1,"memory_mib":256}`)
	})
	mux.HandleFunc("/v1/boxes/b1/metrics", func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(time.Millisecond) // widen the in-flight window
		fmt.Fprintf(w, `{"commands_executed_total":1}`)
	})

	runtime, err := boxlite.NewRest(boxlite.BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	client := &Client{
		runtime: runtime,
		boxes:   make(map[string]*boxlite.Box),
		logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 100 {
				_, _ = client.BoxMetrics(ctx, "b1")
			}
		}()
	}
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 100 {
				client.forgetBox("b1")
			}
		}()
	}
	wg.Wait()

	// A metrics goroutine that wins after the final forgetBox legitimately
	// repopulates the cache, so the stable invariant is at most one live
	// entry — never an accumulation — plus a working lookup.
	client.mu.Lock()
	remaining := len(client.boxes)
	client.mu.Unlock()
	if remaining > 1 {
		t.Fatalf("cache holds %d entries after the race, want at most 1", remaining)
	}
	if _, err := client.GetBox(ctx, "b1"); err != nil {
		t.Fatalf("GetBox after the race: %v", err)
	}
}
