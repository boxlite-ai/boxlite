//go:build boxlite_dev

package controllers

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	runnerconfig "github.com/boxlite-ai/runner/cmd/runner/config"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	blclient "github.com/boxlite-ai/runner/pkg/boxlite"
)

func TestIntegrationGuestPortTunnelRelaysHTTPViaRealVM(t *testing.T) {
	initRunnerConfigForIntegrationTest(t)

	ctx := context.Background()
	homeDir, err := os.MkdirTemp("/tmp", "boxlite-runner-proxy-vm-")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(homeDir) })

	client, err := blclient.NewClient(ctx, blclient.ClientConfig{HomeDir: homeDir})
	if err != nil {
		skipIfRuntimeUnavailable(t, err)
		t.Fatalf("NewClient: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	t.Cleanup(func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := client.Shutdown(shutdownCtx, 10*time.Second); err != nil {
			t.Logf("Shutdown: %v", err)
		}
	})

	boxID := fmt.Sprintf("runner-proxy-vm-%d", time.Now().UnixNano())
	createdID, _, err := client.Create(ctx, dto.CreateBoxDTO{
		Id:           boxID,
		Image:        "alpine:latest",
		OsUser:       "root",
		CpuQuota:     1,
		MemoryQuota:  1,
		StorageQuota: 1,
	})
	if err != nil {
		skipIfRuntimeUnavailable(t, err)
		t.Fatalf("Create: %v", err)
	}
	if createdID == "" {
		t.Fatalf("Create returned empty runtime box id")
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := client.Stop(cleanupCtx, boxID, true); err != nil {
			t.Logf("Stop(%s): %v", boxID, err)
		}
		if err := client.Destroy(cleanupCtx, boxID); err != nil {
			t.Logf("Destroy(%s): %v", boxID, err)
		}
		cleanupLeakedRealVMProcesses(t, homeDir, createdID)
	})

	var stderr strings.Builder
	exec, err := client.StartExecution(ctx, boxID, "sh", []string{
		"-c",
		"while true; do printf 'HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\nvm-proxy-ok\n' | nc -l -p 18080; done",
	}, io.Discard, &stderr, false)
	if err != nil {
		t.Fatalf("StartExecution(httpd): %v", err)
	}
	t.Cleanup(func() {
		_ = exec.Kill(context.Background())
		_ = exec.Close()
	})

	httpClient := http.Client{
		Transport: client.NewGuestPortTransport(boxID, 18080, integrationTestLogger()),
		Timeout:   3 * time.Second,
	}

	waitForRealVMTunnelResponse(t, &httpClient, "vm-proxy-ok\n", func() string {
		return stderr.String()
	})
}

func integrationTestLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func cleanupLeakedRealVMProcesses(t *testing.T, homeDir string, runtimeBoxID string) {
	t.Helper()

	if runtime.GOOS != "linux" || homeDir == "" || runtimeBoxID == "" {
		return
	}

	// The runner/core cleanup path is intentionally exercised first above. This
	// last-resort test cleanup only protects shared KVM hosts from leaked VMs.
	needle := filepath.Join(homeDir, "boxes", runtimeBoxID)
	pids := findProcessesContaining(t, needle)
	if len(pids) == 0 {
		return
	}

	t.Logf("cleaning up leaked VM processes for %s: %v", runtimeBoxID, pids)
	for _, pid := range pids {
		_ = syscall.Kill(pid, syscall.SIGTERM)
	}

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if len(findProcessesContaining(t, needle)) == 0 {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}

	pids = findProcessesContaining(t, needle)
	for _, pid := range pids {
		_ = syscall.Kill(pid, syscall.SIGKILL)
	}
	time.Sleep(100 * time.Millisecond)
	if pids := findProcessesContaining(t, needle); len(pids) > 0 {
		t.Errorf("VM processes still running after cleanup for %s: %v", runtimeBoxID, pids)
	}
}

func findProcessesContaining(t *testing.T, needle string) []int {
	t.Helper()

	psOutput, err := exec.Command("ps", "-eo", "pid=,args=").Output()
	if err != nil {
		t.Logf("ps failed while looking for %q: %v", needle, err)
		return nil
	}

	var pids []int
	for _, line := range strings.Split(string(psOutput), "\n") {
		if !strings.Contains(line, needle) {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil || pid <= 0 {
			continue
		}
		pids = append(pids, pid)
	}
	return pids
}

func initRunnerConfigForIntegrationTest(t *testing.T) {
	t.Helper()

	t.Setenv("BOXLITE_API_URL", "http://127.0.0.1:1/api")
	t.Setenv("BOXLITE_RUNNER_TOKEN", "test-token")
	t.Setenv("ENVIRONMENT", "development")
	if _, err := runnerconfig.GetConfig(); err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
}

func skipIfRuntimeUnavailable(t *testing.T, err error) {
	t.Helper()

	var sdkErr *sdk.Error
	if errors.As(err, &sdkErr) {
		switch sdkErr.Code {
		case sdk.ErrUnsupported, sdk.ErrUnsupportedEngine, sdk.ErrStorage, sdk.ErrImage, sdk.ErrNetwork:
			t.Skipf("runtime prerequisite unavailable (code=%d): %v", sdkErr.Code, err)
		}
	}
}

func waitForRealVMTunnelResponse(t *testing.T, client *http.Client, want string, stderr func() string) {
	t.Helper()

	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	deadline := time.After(45 * time.Second)
	var lastErr error
	var lastBody string
	var lastStatus int

	for {
		resp, err := client.Get("http://127.0.0.1:18080/")
		if err == nil {
			body, readErr := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			lastStatus = resp.StatusCode
			lastBody = string(body)
			if readErr == nil && resp.StatusCode == http.StatusOK && lastBody == want {
				return
			}
			if readErr != nil {
				lastErr = readErr
			}
		} else {
			lastErr = err
		}

		select {
		case <-ticker.C:
		case <-deadline:
			t.Fatalf("real VM tunnel did not return %q within deadline; lastStatus=%d lastBody=%q lastErr=%v stderr=%q", want, lastStatus, lastBody, lastErr, stderr())
		}
	}
}
