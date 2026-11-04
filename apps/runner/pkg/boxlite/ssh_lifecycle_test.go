//go:build boxlite_dev

// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
)

// Exercise the runner's lifecycle decisions through the real SDK's REST
// boundary, without a guest VM or a replacement runtime implementation.
func TestSSHDisableLifecycle(t *testing.T) {
	for _, state := range []string{"configured", "stopped", "running"} {
		t.Run(state, func(t *testing.T) {
			requests := make(chan string, 32)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests <- r.Method + " " + r.URL.Path
				w.Header().Set("Content-Type", "application/json")
				switch {
				case r.Method == http.MethodGet && r.URL.Path == "/v1/boxes/b1":
					fmt.Fprintf(w, `{"box_id":"b1","name":null,"status":%q,"created_at":"2026-11-04T00:00:00Z","updated_at":"2026-11-04T00:00:00Z","pid":null,"image":"alpine:latest","cpus":1,"memory_mib":256}`, state)
				case r.Method == http.MethodDelete && r.URL.Path == "/v1/boxes/b1/ssh":
					io.WriteString(w, `{"enabled":false,"generation":7,"listen_address":"","host_public_key":"","host_key_fingerprint":""}`)
				default:
					http.Error(w, "unexpected request", http.StatusNotFound)
				}
			}))
			defer server.Close()
			runtime, err := boxlite.NewRest(boxlite.BoxliteRestOptions{URL: server.URL})
			if err != nil {
				t.Fatal(err)
			}
			defer runtime.Close()
			client := &Client{runtime: runtime, boxes: make(map[string]*boxlite.Box)}
			defer func() {
				for _, box := range client.boxes {
					box.Close()
				}
			}()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()

			status, err := client.SSHDisable(ctx, "b1")
			if state != "running" {
				if !errors.Is(err, ErrBoxNotRunning) || status != nil {
					t.Fatalf("disable on %s: status=%+v err=%v, want ErrBoxNotRunning and no status", state, status, err)
				}
				if len(client.boxes) != 0 || len(requests) != 1 {
					t.Fatal("idle disable must only read metadata, without fetching a handle")
				}
				if request := <-requests; request != "GET /v1/boxes/b1" {
					t.Fatalf("idle disable sent %s", request)
				}
				observed, err := client.SSHStatus(ctx, "b1")
				if err != nil || observed == nil || *observed != (boxlite.SSHStatus{}) {
					t.Fatalf("idle status: status=%+v err=%v", observed, err)
				}
				if len(client.boxes) != 0 || len(requests) != 1 {
					t.Fatal("idle status must only read metadata")
				}
				return
			}

			if err != nil || status == nil || *status != (boxlite.SSHStatus{Generation: 7}) {
				t.Fatalf("disable on running box: status=%+v err=%v", status, err)
			}
			repeated, err := client.SSHDisable(ctx, "b1")
			if err != nil || repeated == nil || *repeated != *status {
				t.Fatalf("repeat disable: status=%+v err=%v", repeated, err)
			}
			deletes := 0
			for len(requests) > 0 {
				switch request := <-requests; request {
				case "GET /v1/boxes/b1":
				case "DELETE /v1/boxes/b1/ssh":
					deletes++
				default:
					t.Fatalf("unexpected request: %s", request)
				}
			}
			if deletes != 2 {
				t.Fatalf("got %d DELETE requests, want one per call", deletes)
			}
		})
	}
}
