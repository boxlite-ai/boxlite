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
	"sync/atomic"
	"testing"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
)

// Cross the actual Go/C/Rust REST boundary. A replay lookup is only a hint:
// deleting the persisted box before adoption must never produce a replacement.
func TestCredentialReplayRequireExisting(t *testing.T) {
	for _, scenario := range []string{"present", "start existing", "deleted after lookup", "lookup failure"} {
		t.Run(scenario, func(t *testing.T) {
			var reads, creates, starts atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.Method == http.MethodPost && r.URL.Path == "/v1/boxes/box-1/start" {
					starts.Add(1)
					fmt.Fprint(w, `{"box_id":"box-1","name":"box-1","status":"running","created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z","image":"alpine:latest","cpus":1,"memory_mib":128}`)
					return
				}
				if r.Method == http.MethodPost {
					creates.Add(1)
					http.Error(w, "unexpected creation", 500)
					return
				}
				count := reads.Add(1)
				if scenario == "lookup failure" {
					http.Error(w, "runtime unavailable", 503)
					return
				}
				if scenario == "deleted after lookup" && count > 1 {
					http.Error(w, "not found", 404)
					return
				}
				fmt.Fprint(w, `{"box_id":"box-1","name":"box-1","status":"configured","created_at":"2026-11-01T00:00:00Z","updated_at":"2026-11-01T00:00:00Z","image":"alpine:latest","cpus":1,"memory_mib":128}`)
			}))
			defer server.Close()
			runtime, err := sdk.NewRest(sdk.BoxliteRestOptions{URL: server.URL})
			if err != nil {
				t.Fatal(err)
			}
			defer runtime.Close()
			client := &Client{runtime: runtime, homeDir: t.TempDir(), logger: slog.New(slog.NewTextHandler(io.Discard, nil)), boxes: make(map[string]*sdk.Box)}
			defer func() {
				for _, box := range client.boxes {
					_ = box.Close()
				}
			}()
			exists, err := client.BoxExists(context.Background(), "box-1")
			if scenario == "lookup failure" {
				if err == nil || exists {
					t.Fatal("lookup failure became absence")
				}
				return
			}
			if err != nil || !exists {
				t.Fatalf("lookup: exists=%t err=%v", exists, err)
			}
			outbound, skipStart := false, scenario != "start existing"
			_, _, err = client.Create(context.Background(), dto.CreateBoxDTO{Id: "box-1", Image: "alpine:latest", RequireExisting: true, OutboundEnabled: &outbound, SkipStart: &skipStart})
			if (scenario == "present" || scenario == "start existing") && err != nil {
				t.Fatal(err)
			}
			if scenario == "deleted after lookup" && err == nil {
				t.Fatal("missing replay target accepted")
			}
			if creates.Load() != 0 {
				t.Fatal("replay attempted replacement creation")
			}
			if scenario == "start existing" && starts.Load() != 1 {
				t.Fatal("replay did not preserve start behavior")
			}
			if scenario == "deleted after lookup" {
				exists, err = client.BoxExists(context.Background(), "box-1")
				if exists || err != nil {
					t.Fatalf("absence: exists=%t err=%v", exists, err)
				}
			}
		})
	}
}
