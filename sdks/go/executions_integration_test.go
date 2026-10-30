//go:build boxlite_dev

package boxlite

import (
	"context"
	"strings"
	"testing"
	"time"
)

func newInventoryRuntime(t *testing.T) *Runtime {
	t.Helper()
	rt, err := NewRuntime(WithHomeDir(t.TempDir()), WithImageRegistries(
		ImageRegistry{Host: "docker.m.daocloud.io", Search: true},
		ImageRegistry{Host: "docker.xuanyuan.me", Search: true},
		ImageRegistry{Host: "docker.1ms.run", Search: true},
		ImageRegistry{Host: "docker.io", Search: true},
	))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = rt.Close() })
	return rt
}

func TestIntegrationExecutionInventoryControlsDoNotClaimOutput(t *testing.T) {
	rt := newInventoryRuntime(t)
	box := createStartedBoxOrSkip(t, rt, "alpine:latest", WithAutoRemove(false), WithCmd("sleep", "300"))
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	chunks := make(chan string, 32)
	execution, err := box.StartExecution(ctx, "cat", nil, &ExecutionOptions{
		TTY:      true,
		OnStdout: func(chunk []byte) { chunks <- string(chunk) },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer execution.Close()
	if execution.ID() == "" {
		t.Fatal("exec did not expose its canonical guest ID")
	}
	inventory, err := box.ListExecutions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	found, foundMain := false, false
	for _, info := range inventory {
		foundMain = foundMain || info.IsMain
		if info.ExecutionID == execution.ID() {
			found = true
			if info.PID == 0 || info.StartedAt == 0 || !info.TTY || info.IsMain || len(info.Argv) != 1 || info.Argv[0] != "cat" {
				t.Fatalf("incorrect execution metadata: %+v", info)
			}
		}
	}
	if !found || !foundMain {
		t.Fatalf("inventory missing exec/main: %+v", inventory)
	}
	control, err := box.GetExecution(ctx, execution.ID())
	if err != nil {
		t.Fatal(err)
	}
	if control.Stdin != nil || control.ID() != execution.ID() {
		t.Fatal("recovery claimed stdin or changed the guest ID")
	}
	if err := control.ResizeTTY(ctx, 24, 80); err != nil {
		t.Fatal(err)
	}
	if err := control.Signal(ctx, 28); err != nil {
		t.Fatal(err)
	}
	if err := control.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := execution.Write([]byte("reader-still-owned\n")); err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	for !strings.Contains(output.String(), "reader-still-owned") {
		select {
		case chunk := <-chunks:
			output.WriteString(chunk)
		case <-ctx.Done():
			t.Fatal("control recovery stole or closed the original output reader")
		}
	}
	control, err = box.GetExecution(ctx, execution.ID())
	if err != nil {
		t.Fatal(err)
	}
	defer control.Close()
	if err := control.Kill(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := control.Wait(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := execution.Wait(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestIntegrationAttachExecutionReaderRecovery(t *testing.T) {
	rt := newInventoryRuntime(t)
	box := createStartedBoxOrSkip(t, rt, "alpine:latest", WithAutoRemove(false),
		WithCmd("sh", "-c", "while true; do echo inventory-heartbeat; sleep 0.1; done"))
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	inventory, err := box.ListExecutions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var mainID string
	for _, info := range inventory {
		if info.IsMain {
			mainID = info.ExecutionID
		}
	}
	if mainID == "" {
		t.Fatal("main command absent from live inventory")
	}
	reader, err := box.AttachExecution(ctx, mainID, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	if other, err := box.AttachExecution(ctx, mainID, nil); err == nil {
		other.Close()
		t.Fatal("second active reader stole the original output stream")
	}
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	freshBox, err := rt.Get(ctx, box.ID())
	if err != nil {
		t.Fatal(err)
	}
	defer freshBox.Close()
	chunks := make(chan string, 32)
	var attached *Execution
	for attached == nil {
		attached, err = freshBox.AttachExecution(ctx, mainID, &ExecutionOptions{
			OnStdout: func(chunk []byte) { chunks <- string(chunk) },
		})
		if err != nil {
			select {
			case <-time.After(10 * time.Millisecond):
			case <-ctx.Done():
				t.Fatalf("reader was not released for fresh client: %v", err)
			}
		}
	}
	defer attached.Close()
	select {
	case chunk := <-chunks:
		if !strings.Contains(chunk, "inventory-heartbeat") {
			t.Fatalf("unexpected recovered output: %q", chunk)
		}
	case <-ctx.Done():
		t.Fatal("fresh client received no live output")
	}
	if attached.ID() != mainID {
		t.Fatal("attach changed the guest execution ID")
	}
	if err := attached.Kill(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestIntegrationListExecutionsNeverBootsCreatedBox(t *testing.T) {
	rt := newInventoryRuntime(t)
	ctx := context.Background()
	box, err := rt.Create(ctx, "alpine:latest", WithAutoRemove(false))
	if err != nil {
		t.Fatal(err)
	}
	defer box.Close()
	defer rt.ForceRemove(ctx, box.ID())
	before, err := box.Info(ctx)
	if err != nil {
		t.Fatal(err)
	}
	inventory, err := box.ListExecutions(ctx)
	if err != nil || len(inventory) != 0 {
		t.Fatalf("created box inventory = %+v, %v; want empty success", inventory, err)
	}
	after, err := box.Info(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if after.State != before.State || after.Running || after.PID != before.PID {
		t.Fatalf("inventory booted box: before=%+v after=%+v", before, after)
	}
}
