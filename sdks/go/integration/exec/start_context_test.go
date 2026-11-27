//go:build boxlite_dev && boxlite_integration

package exec_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
)

// The delayed REST response controls admission, while the command and its
// termination run through the native C runtime in a real micro-VM.
func TestIntegrationStartExecutionCancelReapsLateVMProcess(t *testing.T) {
	options := []boxlite.RuntimeOption{boxlite.WithHomeDir(t.TempDir())}
	image := os.Getenv("BOXLITE_GO_VM_IMAGE")
	if image == "" {
		if registry := os.Getenv("BOXLITE_TEST_REGISTRY"); registry != "" {
			options = append(options, boxlite.WithImageRegistry(boxlite.ImageRegistry{
				Host:      registry,
				Transport: boxlite.RegistryTransportHTTP,
				Search:    true,
			}))
			image = "alpine:latest"
		} else {
			image = "public.ecr.aws/docker/library/alpine:latest"
		}
	}
	native, err := boxlite.NewRuntime(options...)
	if err != nil {
		t.Fatal(err)
	}
	defer native.Close()
	ctx, stop := context.WithTimeout(context.Background(), 90*time.Second)
	defer stop()
	box, err := native.Create(ctx, image, boxlite.WithAutoRemove(false), boxlite.WithCmd("sleep", "300"))
	if err != nil {
		t.Fatal(err)
	}
	defer box.Close()
	defer native.ForceRemove(context.Background(), box.ID())
	if err := box.Start(ctx); err != nil {
		t.Fatalf("real VM prerequisite: %v", err)
	}

	probe, err := box.Exec(ctx, "sh", "-c", "uname -s; echo native-vm-ready")
	if err != nil || probe.ExitCode != 0 || !strings.Contains(probe.Stdout, "native-vm-ready") {
		t.Fatalf("real VM smoke failed: result=%+v err=%v", probe, err)
	}
	t.Logf("real VM started: %s, output=%q", box.ID(), probe.Stdout)

	mux := http.NewServeMux()
	admitted := make(chan *boxlite.Execution, 1)
	release := make(chan struct{})
	releaseOnce := sync.OnceFunc(func() { close(release) })
	terminated := make(chan error, 1)
	var workload *boxlite.Execution
	mux.HandleFunc("POST /v1/boxes/box1/exec", func(w http.ResponseWriter, _ *http.Request) {
		var startErr error
		workload, startErr = box.StartExecution(ctx, "sh", []string{"-c", "echo $$ > /tmp/context-cancel.pid; exec sleep 60"}, nil)
		if startErr != nil {
			http.Error(w, startErr.Error(), http.StatusInternalServerError)
			admitted <- nil
			return
		}
		admitted <- workload
		<-release
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, "{\"execution_id\":\"late-real-vm\"}")
	})
	const cleanupTimeout = 10 * time.Second
	mux.HandleFunc("DELETE /v1/boxes/box1/executions/late-real-vm", func(w http.ResponseWriter, _ *http.Request) {
		cleanupCtx, cancel := context.WithTimeout(ctx, cleanupTimeout)
		defer cancel()

		err := workload.Kill(cleanupCtx)
		if err == nil {
			var exitCode int
			exitCode, err = workload.Wait(cleanupCtx)
			if err == nil && exitCode != -int(syscall.SIGKILL) {
				err = fmt.Errorf("guest process exited with %d, want %d (SIGKILL)", exitCode, -int(syscall.SIGKILL))
			}
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		} else {
			w.WriteHeader(http.StatusNoContent)
		}
		terminated <- err
	})
	mux.HandleFunc("GET /v1/boxes/box1/executions/late-real-vm", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, "{\"execution_id\":\"late-real-vm\",\"status\":\"completed\",\"exit_code\":137}")
	})
	mux.HandleFunc("GET /v1/boxes/box1", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"box_id":"box1","status":"running","created_at":"2026-07-14T00:00:00Z","updated_at":"2026-07-14T00:00:00Z","image":"alpine","cpus":1,"memory_mib":256}`)
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	rest, err := boxlite.NewRest(boxlite.BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer rest.Close()
	client, err := rest.Get(ctx, "box1")
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	// Release the response before closing any client or runtime.
	defer releaseOnce()
	startup, cancel := context.WithCancel(ctx)
	defer cancel()
	returned := make(chan error, 1)
	go func() {
		execution, startErr := client.StartExecution(startup, "sleep", []string{"60"}, nil)
		if execution != nil {
			_ = execution.Close()
		}
		returned <- startErr
	}()
	select {
	case execution := <-admitted:
		if execution == nil {
			t.Fatal("real VM workload failed to start")
		}
		defer execution.Close()
	case <-ctx.Done():
		t.Fatal("real VM workload was not admitted")
	}
	var pid string
	for pid == "" {
		result, readErr := box.Exec(ctx, "cat", "/tmp/context-cancel.pid")
		if readErr == nil && result.ExitCode == 0 {
			pid = strings.TrimSpace(result.Stdout)
		}
		if ctx.Err() != nil {
			t.Fatal("real workload PID was not observable")
		}
	}
	live, err := box.Exec(ctx, "kill", "-0", pid)
	if err != nil || live.ExitCode != 0 {
		t.Fatalf("guest process %s was not alive: %v", pid, err)
	}
	t.Logf("guest process %s alive while REST launch response is withheld", pid)
	cancel()
	select {
	case startErr := <-returned:
		if !errors.Is(startErr, context.Canceled) {
			t.Fatalf("StartExecution returned %v; want context canceled", startErr)
		}
	case <-time.After(2 * time.Second):
		releaseOnce()
		select {
		case <-returned:
		case <-time.After(5 * time.Second):
			t.Fatal("StartExecution did not finish after the real VM response was released")
		}
		t.Fatal("StartExecution stayed blocked until the real VM response was released")
	}
	releaseOnce()
	select {
	case killErr := <-terminated:
		if killErr != nil {
			t.Fatal(killErr)
		}
	case <-time.After(cleanupTimeout):
		t.Fatal("late execution did not terminate within the cleanup deadline")
	}
	dead, err := box.Exec(ctx, "kill", "-0", pid)
	if err != nil || dead.ExitCode == 0 {
		t.Fatalf("guest process %s survived late handle cleanup: result=%+v err=%v", pid, dead, err)
	}
	check, err := box.Exec(ctx, "echo", "vm-still-healthy")
	if err != nil || check.ExitCode != 0 || strings.TrimSpace(check.Stdout) != "vm-still-healthy" {
		t.Fatalf("VM unusable after cleanup: result=%+v err=%v", check, err)
	}
	t.Logf("guest process %s exited on SIGKILL and was reaped; VM still executes commands", pid)
}
