//go:build boxlite_dev

package boxlite

import (
	"context"
	"errors"
	"testing"
	"time"
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

func TestSSHUsageWaitsForHandleOwnership(t *testing.T) {
	box := newSSHServer(t).box(t)
	box.mu.Lock()
	entered := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		close(entered)
		_, err := box.SSH().TakeUsage(context.Background())
		result <- err
	}()
	<-entered
	select {
	case err := <-result:
		box.mu.Unlock()
		t.Fatalf("usage completed while the handle was exclusively locked: %v", err)
	case <-time.After(200 * time.Millisecond):
	}
	box.mu.Unlock()
	var native *Error
	if err := waitForSSH(t, result, "usage after releasing the lock"); !errors.As(err, &native) || native.Code != ErrUnsupported {
		t.Fatalf("REST usage: %v", err)
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
