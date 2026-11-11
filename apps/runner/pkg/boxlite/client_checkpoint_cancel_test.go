// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"

	"github.com/boxlite-ai/runner/cmd/runner/config"
	"github.com/boxlite-ai/runner/pkg/api/dto"
)

func TestCheckpointExportRejectsRunningSourceBeforeNativeExport(t *testing.T) {
	var exports atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/config" {
			_, _ = io.WriteString(w, `{"capabilities":{"export_enabled":true}}`)
			return
		}
		if r.Method == http.MethodGet {
			_, _ = io.WriteString(w, `{"box_id":"source","name":"source","status":"running","image":"alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","cpus":1,"memory_mib":128,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}`)
			return
		}
		exports.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = io.WriteString(w, `{"error":{"code":"internal_error","message":"unexpected native export"}}`)
	}))
	defer server.Close()
	runtime, err := sdk.NewRest(sdk.BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	client := &Client{runtime: runtime, homeDir: t.TempDir(), logger: slog.Default(), boxes: make(map[string]*sdk.Box)}
	defer client.Close()
	_, _, err = client.ExportCheckpoint(context.Background(), "source", t.TempDir())
	if exports.Load() != 0 {
		t.Fatal("running source reached native export")
	}
	if err == nil || !strings.Contains(err.Error(), "stopped") {
		t.Fatalf("expected stopped-source refusal, got %v", err)
	}
}

func TestCheckpointCreateCancellationKeepsLeaseAfterNativeAdmission(t *testing.T) {
	admitted, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"error":{"message":"missing","code":"not_found"}}`)
			return
		}
		close(admitted)
		<-release
		_, _ = io.WriteString(w, `{"box_id":"native-target","name":"accepted-target","status":"stopped","image":"alpine:latest","cpus":1,"memory_mib":128,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}`)
	}))
	defer server.Close()
	runtime, err := sdk.NewRest(sdk.BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	client := &Client{runtime: runtime, homeDir: t.TempDir(), logger: slog.Default(), boxes: make(map[string]*sdk.Box)}
	defer client.Close()
	defer unblock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	enabled, skipStart := true, true
	go func() {
		_, _, err := client.Create(ctx, dto.CreateBoxDTO{Id: "accepted-target", Image: "alpine:latest", OutboundEnabled: &enabled, SkipStart: &skipStart})
		done <- err
	}()
	select {
	case <-admitted:
	case err := <-done:
		t.Fatalf("creation failed before native admission: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatal("native creation was not admitted")
	}
	cancel()
	lockCtx, stop := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer stop()
	lease, err := client.checkpointOperations().Lock(lockCtx, "accepted-target")
	if err == nil {
		lease.Close()
		t.Fatal("target lease released while native creation was still running")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	unblock()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("native completion was not delivered")
	}
	completedCtx, completedCancel := context.WithTimeout(context.Background(), time.Second)
	defer completedCancel()
	lease, err = client.checkpointOperations().Lock(completedCtx, "accepted-target")
	if err != nil {
		t.Fatal(err)
	}
	lease.Close()
}

func TestCheckpointCreateCancellationReleasesLeaseDuringVolumePreparation(t *testing.T) {
	t.Setenv("BOXLITE_API_URL", "http://127.0.0.1:1")
	t.Setenv("BOXLITE_RUNNER_TOKEN", "test-token")
	t.Setenv("RUNNER_DOMAIN", "127.0.0.1")
	if _, err := config.GetConfig(); err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	signal := filepath.Join(bin, "probe-started")
	if err := os.WriteFile(filepath.Join(bin, "mountpoint"), []byte("#!/bin/sh\necho $$ > \"$CHECKPOINT_PROBE_SIGNAL\"\nexec /bin/sleep 10\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("CHECKPOINT_PROBE_SIGNAL", signal)
	client := &Client{homeDir: t.TempDir(), logger: slog.Default(), volumeMutexes: make(map[string]*sync.Mutex)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	enabled := true
	go func() {
		_, _, err := client.Create(ctx, dto.CreateBoxDTO{
			Id: "cancel-preparation", Image: "alpine:latest", OutboundEnabled: &enabled,
			Volumes: []dto.VolumeDTO{{VolumeId: "checkpoint-cancel-test", MountPath: "/data"}},
		})
		done <- err
	}()
	var pid int
	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
waitForProbe:
	for {
		select {
		case <-tick.C:
			if data, err := os.ReadFile(signal); err == nil {
				pid, err = strconv.Atoi(strings.TrimSpace(string(data)))
				if err == nil {
					break waitForProbe
				}
			}
		case err := <-done:
			t.Fatalf("create returned before the probe: %v", err)
		case <-deadline.C:
			t.Fatal("mount probe did not start")
		}
	}
	defer func() {
		if pid > 0 {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}()
	cancel()
	select {
	case err := <-done:
		pid = 0
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected caller cancellation, got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Create ignored cancellation during volume preparation")
	}
	lockCtx, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	lease, err := client.checkpointOperations().Lock(lockCtx, "cancel-preparation")
	if err != nil {
		t.Fatalf("target lease remained held: %v", err)
	}
	lease.Close()
}
