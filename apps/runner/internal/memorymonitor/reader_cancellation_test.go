//go:build linux

package memorymonitor

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestMemoryIncidentBlockedReadCancellation(t *testing.T) {
	root := t.TempDir()
	proc, groups := filepath.Join(root, "proc"), filepath.Join(root, "groups")
	member := filepath.Join(proc, "123", "cgroup")
	counter := filepath.Join(groups, "boxlite", "runtime-a", "memory.current")
	for _, dir := range []string{filepath.Dir(member), filepath.Dir(counter)} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(member, []byte("0::/boxlite/runtime-a\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(counter, 0600); err != nil {
		t.Fatal(err)
	}
	// Keep a writer open so ReadFile cannot finish until the fixture is released.
	writer, err := os.OpenFile(counter, os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	read := newMemoryReader(proc, groups)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := read(ctx, Box{PID: 123, RuntimeID: "runtime-a"}); done <- err }()
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Errorf("got %v, want deadline exceeded", err)
		}
	case <-time.After(time.Second):
		t.Error("blocked cgroup read ignored cancellation")
	}
	// A later scan must wait for the outstanding kernel read, rather than
	// starting another worker after the first caller's deadline.
	otherMember := filepath.Join(proc, "456", "cgroup")
	otherCounter := filepath.Join(groups, "boxlite", "runtime-b", "memory.current")
	for _, dir := range []string{filepath.Dir(otherMember), filepath.Dir(otherCounter)} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(otherMember, []byte("0::/boxlite/runtime-b\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(otherCounter, []byte("42\n"), 0600); err != nil {
		t.Fatal(err)
	}
	next, stop := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer stop()
	box := Box{PID: 456, RuntimeID: "runtime-b"}
	if _, err := read(next, box); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("started another read while the first was blocked: %v", err)
	}
	writer.Close()
	resumed, finish := context.WithTimeout(context.Background(), time.Second)
	defer finish()
	if value, err := read(resumed, box); err != nil || value != 42 {
		t.Fatalf("did not resume after the blocked read finished: bytes=%d error=%v", value, err)
	}
}
