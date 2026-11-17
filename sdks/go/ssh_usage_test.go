//go:build boxlite_dev

package boxlite

import (
	"context"
	"errors"
	"testing"
)

func TestSSHUsageRESTIsUnsupportedWithoutHTTPRequest(t *testing.T) {
	server := newSSHServer(t)
	box := server.box(t)
	batch, err := box.SSH().TakeUsage(context.Background())
	var native *Error
	if batch != nil || !errors.As(err, &native) || native.Code != ErrUnsupported {
		t.Fatalf("batch=%v err=%v", batch, err)
	}
	if len(server.received()) != 0 {
		t.Fatal("local evidence attempted a REST request")
	}
}

func TestSSHUsageRejectsCanceledAndClosedHandles(t *testing.T) {
	server := newSSHServer(t)
	box := server.box(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := box.SSH().TakeUsage(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	box.Close()
	if _, err := box.SSH().TakeUsage(context.Background()); !IsInvalidState(err) {
		t.Fatal(err)
	}
	var ssh *SSH
	if _, err := ssh.TakeUsage(context.Background()); !IsInvalidState(err) {
		t.Fatal(err)
	}
}

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
