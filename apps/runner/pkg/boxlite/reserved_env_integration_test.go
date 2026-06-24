//go:build boxlite_dev

package boxlite

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"os"
	"strings"
	"testing"

	sdkboxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/cmd/runner/config"
	"github.com/boxlite-ai/runner/pkg/api/dto"
)

func newIntegrationClient(t *testing.T) *Client {
	t.Helper()

	homeDir, err := os.MkdirTemp("/tmp", "boxlite-runner-")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() {
		_ = os.RemoveAll(homeDir)
	})

	t.Setenv("BOXLITE_API_URL", "http://127.0.0.1")
	t.Setenv("BOXLITE_RUNNER_TOKEN", "test-token")
	t.Setenv("ENVIRONMENT", "development")
	if _, err := config.GetConfig(); err != nil {
		t.Fatalf("GetConfig: %v", err)
	}

	client, err := NewClient(context.Background(), ClientConfig{
		HomeDir: homeDir,
		Logger:  slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})),
	})
	if err != nil {
		var boxErr *sdkboxlite.Error
		if errors.As(err, &boxErr) && (boxErr.Code == sdkboxlite.ErrUnsupported || boxErr.Code == sdkboxlite.ErrUnsupportedEngine) {
			t.Skipf("runtime not available: %v", err)
		}
		t.Fatalf("NewClient: %v", err)
	}
	t.Cleanup(func() {
		_ = client.Close()
	})
	return client
}

func TestIntegrationReservedExecutorEnvPolicyWithRealVM(t *testing.T) {
	ctx := context.Background()
	client := newIntegrationClient(t)

	const boxID = "reserved-env-real-vm"
	_, _, err := client.Create(ctx, dto.CreateBoxDTO{
		Id:           boxID,
		Image:        "alpine:latest",
		OsUser:       "boxlite",
		CpuQuota:     1,
		MemoryQuota:  1,
		StorageQuota: 1,
		Env: map[string]string{
			ReservedExecutorEnv: "guest",
			"BOXLITE_TEST_KEY":  "from-create",
		},
	})
	if err != nil {
		var boxErr *sdkboxlite.Error
		if errors.As(err, &boxErr) && (boxErr.Code == sdkboxlite.ErrStorage || boxErr.Code == sdkboxlite.ErrImage || boxErr.Code == sdkboxlite.ErrNetwork) {
			t.Skipf("infrastructure prerequisite unavailable (code=%d): %v", boxErr.Code, err)
		}
		t.Fatalf("Create normal VM: %v", err)
	}
	t.Cleanup(func() {
		_ = client.Destroy(ctx, boxID)
	})

	var out bytes.Buffer
	exec, err := client.StartExecution(ctx, boxID, "sh", []string{"-c", "printenv BOXLITE_EXECUTOR && printenv BOXLITE_TEST_KEY"}, &out, &out, false)
	if err != nil {
		t.Fatalf("StartExecution: %v", err)
	}
	if _, err := exec.Wait(ctx); err != nil {
		t.Fatalf("Wait: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected executor and create env lines, got %q", out.String())
	}
	if !strings.HasPrefix(lines[0], "container=") {
		t.Fatalf("default exec should use container executor, got %q", lines[0])
	}
	if lines[1] != "from-create" {
		t.Fatalf("ordinary create env did not reach VM: got %q", lines[1])
	}

	bx, err := client.GetBox(ctx, boxID)
	if err != nil {
		t.Fatalf("GetBox: %v", err)
	}

	manager := NewExecManager()
	t.Cleanup(manager.Stop)
	localExecID, err := manager.Start(ctx, bx, boxID, StartOptions{
		Command: "sh",
		Args:    []string{"-c", "printenv BOXLITE_EXECUTOR"},
		Env: map[string]string{
			ReservedExecutorEnv: "guest",
		},
	})
	if err != nil {
		if strings.Contains(err.Error(), "BOXLITE_EXECUTOR is reserved") {
			t.Fatalf("local admin executor env should not be rejected: %v", err)
		}
		t.Fatalf("Start local admin exec: %v", err)
	}

	localExec, ok := manager.Get(localExecID)
	if !ok {
		t.Fatalf("local exec %s was not registered", localExecID)
	}
	<-localExec.Done
	if localExec.Err != nil {
		t.Fatalf("local admin exec wait: %v", localExec.Err)
	}
	stdout, _, cancel := localExec.Subscribe(4)
	defer cancel()
	var localOut bytes.Buffer
	for chunk := range stdout.Chan() {
		localOut.Write(chunk)
	}
	if strings.TrimSpace(localOut.String()) != "guest" {
		t.Fatalf("local admin executor env did not reach execution: got %q", localOut.String())
	}
}
