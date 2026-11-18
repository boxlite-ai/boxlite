// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

package boxlite

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/internal/timing"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/google/uuid"
)

type createTimingWriter struct {
	lines chan string
	err   error
}

func (w createTimingWriter) Write(p []byte) (int, error) {
	w.lines <- string(p)
	if w.err != nil {
		return 0, w.err
	}
	return len(p), nil
}

func TestCreateTimingSkipStartAndWriteFailure(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
	}{
		{name: "working_writer"},
		{name: "failing_writer", err: errors.New("timing sink failed")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet && r.URL.Path == "/v1/boxes/timing-target" {
					w.WriteHeader(http.StatusNotFound)
					_, _ = w.Write([]byte(`{"error":{"code":"not_found","message":"missing"}}`))
					return
				}
				if r.Method != http.MethodPost || r.URL.Path != "/v1/boxes" {
					t.Errorf("unexpected request (SkipStart must not start the box): %s %s", r.Method, r.URL.Path)
					http.NotFound(w, r)
					return
				}
				_, _ = w.Write([]byte(`{"box_id":"native-target","name":"timing-target","status":"stopped","image":"alpine:latest","cpus":1,"memory_mib":128,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}`))
			}))
			defer server.Close()
			boxRuntime, err := sdk.NewRest(sdk.BoxliteRestOptions{URL: server.URL})
			if err != nil {
				t.Fatal(err)
			}
			client := &Client{runtime: boxRuntime, homeDir: t.TempDir(), logger: slog.Default(), boxes: make(map[string]*sdk.Box)}
			defer client.Close()

			lines := make(chan string, 4)
			t.Cleanup(timing.SetWriterForTest(createTimingWriter{lines: lines, err: tc.err}))
			ctx := timing.WithJobID(t.Context(), "job-1")
			enabled, skipStart := true, true
			id, version, err := client.Create(ctx, dto.CreateBoxDTO{
				Id: "timing-target", Image: "alpine:latest", OutboundEnabled: &enabled, SkipStart: &skipStart,
			})
			if id != "native-target" || version != "boxlite" || err != nil {
				t.Fatalf("Create returned (%q, %q, %v), want (native-target, boxlite, nil)", id, version, err)
			}

			for _, want := range []struct{ stage, status string }{
				{"create.runtime_getorcreate", "ok"}, {"create.started", "skipped"}, {"create.client", "ok"},
			} {
				select {
				case line := <-lines:
					var got struct {
						Stage  string `json:"stage"`
						Status string `json:"status"`
						timing.IDs
					}
					if err := json.Unmarshal([]byte(line), &got); err != nil || got.Stage != want.stage || got.Status != want.status || got.BoxID != "timing-target" || got.JobID != "job-1" {
						t.Fatalf("got %s (%v), want stage=%s status=%s, box_id=timing-target, job_id=job-1", line, err, want.stage, want.status)
					}
				case <-time.After(2 * time.Second):
					t.Fatalf("did not observe timing stage %s", want.stage)
				}
			}
		})
	}
}

func TestDestroyClientTiming(t *testing.T) {
	useVolumeMountBasePath(t, t.TempDir())
	t.Cleanup(timing.SetWriterForTest(io.Discard))
	for _, tc := range []struct {
		name, body                  string
		code                        int
		runtimeStatus, clientStatus string
	}{
		{"removed", "", http.StatusNoContent, timing.OK, timing.OK},
		{"absent", `{"error":{"code":"not_found","message":"absent"}}`, http.StatusNotFound, timing.Skipped, timing.Skipped},
		{"failed", `{"error":{"code":"internal","message":"remove failed"}}`, http.StatusInternalServerError, timing.Error, timing.Error},
		{"not attempted", "", 0, timing.Skipped, timing.Error},
	} {
		t.Run(tc.name, func(t *testing.T) {
			boxID := "destroy-timing-" + uuid.NewString()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.code == 0 || r.Method != http.MethodDelete || r.URL.Path != "/v1/boxes/"+boxID || r.URL.Query().Get("force") != "true" {
					t.Errorf("unexpected runtime request: %s %s", r.Method, r.URL)
					http.NotFound(w, r)
					return
				}
				w.WriteHeader(tc.code)
				if tc.body != "" {
					_, _ = io.WriteString(w, tc.body)
				}
			}))
			defer server.Close()
			rt, err := sdk.NewRest(sdk.BoxliteRestOptions{URL: server.URL})
			if err != nil {
				t.Fatal(err)
			}
			client := &Client{
				runtime: rt, homeDir: t.TempDir(), logger: slog.Default(),
				volumeCleanup: volumeCleanupConfig{interval: time.Hour}, lastVolumeCleanup: time.Now(),
			}
			defer client.Close()

			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if tc.code == 0 {
				cancel()
			}
			ctx, skipped := timing.WithDestroySkipped(timing.WithJobID(ctx, "job-1"))
			err = client.Destroy(ctx, boxID)
			if (err != nil) != (tc.clientStatus == timing.Error) || *skipped != (tc.clientStatus == timing.Skipped) {
				t.Fatalf("Destroy error = %v, absent = %t", err, *skipped)
			}
			events := timing.Snapshot(boxID)
			if len(events) != 2 {
				t.Fatalf("expected runtime and client phases, got %+v", events)
			}
			for i, want := range []struct{ stage, status string }{
				{"destroy.runtime", tc.runtimeStatus}, {"destroy.client", tc.clientStatus},
			} {
				e := events[i]
				if e.Op != "destroy" || e.Stage != want.stage || e.Status != want.status || e.BoxID != boxID || e.JobID != "job-1" {
					t.Fatalf("event = %+v, want %v for %s", e, want, boxID)
				}
			}
		})
	}
}
