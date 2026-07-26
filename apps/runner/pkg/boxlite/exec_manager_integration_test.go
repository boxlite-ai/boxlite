//go:build boxlite_dev

package boxlite

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
)

func TestIntegrationExecManagerRecordsTimedOut(t *testing.T) {
	ctx := context.Background()
	homeDir, err := os.MkdirTemp("/tmp", "boxlite-runner-timeout-")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(homeDir) })

	rt, err := sdk.NewRuntime(sdk.WithHomeDir(homeDir))
	if err != nil {
		var sdkErr *sdk.Error
		if errors.As(err, &sdkErr) && (sdkErr.Code == sdk.ErrUnsupported || sdkErr.Code == sdk.ErrUnsupportedEngine) {
			t.Skipf("runtime not available: %v", err)
		}
		t.Fatalf("NewRuntime: %v", err)
	}
	t.Cleanup(func() { _ = rt.Close() })

	box, err := rt.Create(ctx, "alpine:latest", sdk.WithAutoRemove(false))
	if err != nil {
		skipInfraError(t, "Create", err)
		t.Fatalf("Create: %v", err)
	}
	t.Cleanup(func() {
		_ = box.Stop(ctx)
		_ = rt.ForceRemove(ctx, box.ID())
		_ = box.Close()
	})
	if err := box.Start(ctx); err != nil {
		skipInfraError(t, "Start", err)
		t.Fatalf("Start: %v", err)
	}

	mgr := NewExecManager()
	t.Cleanup(func() { mgr.Stop() })
	id, err := mgr.Start(ctx, box, box.ID(), StartOptions{
		Command: "sleep",
		Args:    []string{"20"},
		Timeout: 2 * time.Second,
	})
	if err != nil {
		t.Fatalf("ExecManager.Start: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Kill(id) })

	exec, ok := mgr.Get(id)
	if !ok {
		t.Fatalf("exec %s not registered", id)
	}
	select {
	case <-exec.Done:
	case <-time.After(15 * time.Second):
		t.Fatalf("timed exec did not complete within 15s")
	}
	if exec.Err != nil {
		t.Fatalf("wait returned error: %v", exec.Err)
	}
	if !exec.TimedOut {
		t.Fatalf("expected TimedOut=true, got exit_code=%d", exec.ExitCode)
	}
	if exec.ExitCode == 0 {
		t.Fatalf("expected non-zero timeout exit code")
	}
}

func skipInfraError(t *testing.T, op string, err error) {
	t.Helper()
	var sdkErr *sdk.Error
	if errors.As(err, &sdkErr) && (sdkErr.Code == sdk.ErrStorage || sdkErr.Code == sdk.ErrImage || sdkErr.Code == sdk.ErrNetwork) {
		t.Skipf("%s infrastructure prerequisite unavailable (code=%d): %v", op, sdkErr.Code, err)
	}
}
