//go:build boxlite_dev

package boxlite

import (
	"context"
	"errors"
	"sync"
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

// Signal when TakeUsage has submitted the native operation and selects a completion.
type usageWaitContext struct {
	context.Context
	waiting chan struct{}
	once    sync.Once
}

func (ctx *usageWaitContext) Done() <-chan struct{} {
	ctx.once.Do(func() { close(ctx.waiting) })
	return ctx.Context.Done()
}

func TestSSHUsagePendingDrainObservesCancellationAndShutdown(t *testing.T) {
	for _, shutdown := range []bool{false, true} {
		name := "cancel"
		if shutdown {
			name = "runtime close"
		}
		t.Run(name, func(t *testing.T) {
			box := newSSHServer(t).box(t)
			box.runtime.stopDrain()
			parent, cancel := context.WithCancel(t.Context())
			defer cancel()
			ctx := &usageWaitContext{Context: parent, waiting: make(chan struct{})}
			done := make(chan error, 1)
			go func() { _, err := box.SSH().TakeUsage(ctx); done <- err }()
			waitForSSH(t, ctx.waiting, "native submission")
			want := context.Canceled
			if shutdown {
				if err := box.runtime.Close(); err != nil {
					t.Fatal(err)
				}
				want = ErrRuntimeClosed
				if _, err := box.SSH().TakeUsage(t.Context()); !errors.Is(err, ErrRuntimeClosed) {
					t.Fatalf("already closed runtime: %v", err)
				}
			} else {
				cancel()
			}
			if err := waitForSSH(t, done, "pending usage drain"); !errors.Is(err, want) {
				t.Fatalf("pending drain: got %v, want %v", err, want)
			}
		})
	}
}
