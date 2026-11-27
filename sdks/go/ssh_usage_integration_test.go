//go:build boxlite_dev && boxlite_integration

package boxlite

import (
	"context"
	"testing"
)

func TestSSHUsageConfiguredLocalBoxReturnsOwnedEmptyBatchWithoutBoot(t *testing.T) {
	rt, err := NewRuntime(WithHomeDir(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	box, err := rt.Create(context.Background(), "alpine:latest", WithName("usage-idle"), WithAutoRemove(false))
	if err != nil {
		t.Fatal(err)
	}
	defer box.Close()
	batch, err := box.SSH().TakeUsage(context.Background())
	if err != nil || batch == nil || len(batch.Events) != 0 || batch.DroppedTotal != 0 {
		t.Fatalf("batch=%v err=%v", batch, err)
	}
	info, err := box.Info(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if info.Running || info.PID != 0 {
		t.Fatalf("usage observation booted the Box: %#v", info)
	}
}
