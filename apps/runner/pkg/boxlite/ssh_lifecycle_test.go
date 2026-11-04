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
func TestSSHControlLifecycle(t *testing.T) {
	for _, operation := range []struct {
		name    string
		request string
		call    func(*Client, context.Context, string) (*boxlite.SSHStatus, error)
		status  boxlite.SSHStatus
	}{
		{"disable", "DELETE /v1/boxes/b1/ssh", (*Client).SSHDisable, boxlite.SSHStatus{Generation: 7}},
		{"enable", "POST /v1/boxes/b1/ssh/enable", (*Client).SSHEnable, boxlite.SSHStatus{
			Enabled: true, Generation: 8, ListenAddress: "0.0.0.0:2222",
			HostPublicKey: "ssh-ed25519 host-key", HostKeyFingerprint: "SHA256:host-fingerprint",
		}},
	} {
		t.Run(operation.name, func(t *testing.T) {
			for _, state := range []string{"configured", "stopped", "running"} {
				t.Run(state, func(t *testing.T) {
					requests := make(chan string, 32)
					server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						requests <- r.Method + " " + r.URL.Path
						w.Header().Set("Content-Type", "application/json")
						switch {
						case r.Method == http.MethodGet && r.URL.Path == "/v1/boxes/b1":
							fmt.Fprintf(w, `{"box_id":"b1","name":null,"status":%q,"created_at":"2026-11-04T00:00:00Z","updated_at":"2026-11-04T00:00:00Z","pid":null,"image":"alpine:latest","cpus":1,"memory_mib":256}`, state)
						case r.Method+" "+r.URL.Path == operation.request:
							body, err := io.ReadAll(r.Body)
							if err != nil || len(body) != 0 {
								t.Errorf("control request body = %q, err = %v; want empty", body, err)
							}
							status := operation.status
							fmt.Fprintf(w, `{"enabled":%t,"generation":%d,"listen_address":%q,"host_public_key":%q,"host_key_fingerprint":%q}`,
								status.Enabled, status.Generation, status.ListenAddress, status.HostPublicKey, status.HostKeyFingerprint)
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

					status, err := operation.call(client, ctx, "b1")
					if state != "running" {
						if !errors.Is(err, ErrBoxNotRunning) || status != nil {
							t.Fatalf("control on %s: status=%+v err=%v, want ErrBoxNotRunning and no status", state, status, err)
						}
						if len(client.boxes) != 0 || len(requests) != 1 {
							t.Fatal("idle control must only read metadata, without fetching a handle")
						}
						if request := <-requests; request != "GET /v1/boxes/b1" {
							t.Fatalf("idle control sent %s", request)
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

					if err != nil || status == nil || *status != operation.status {
						t.Fatalf("control on running box: status=%+v err=%v", status, err)
					}
					repeated, err := operation.call(client, ctx, "b1")
					if err != nil || repeated == nil || *repeated != *status {
						t.Fatalf("repeat control: status=%+v err=%v", repeated, err)
					}
					controls := 0
					for len(requests) > 0 {
						switch request := <-requests; request {
						case "GET /v1/boxes/b1":
						case operation.request:
							controls++
						default:
							t.Fatalf("unexpected request: %s", request)
						}
					}
					if controls != 2 {
						t.Fatalf("got %d control requests, want one per call", controls)
					}
				})
			}
		})
	}
}
