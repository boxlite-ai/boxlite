package main

import (
	"context"
	"errors"
	"net"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestRunQemuAcceptLoop_ListenerCloseSurfacesViaSink is the
// production-shaped two-sided proof for the wiring fix on `main.go`'s
// Linux Qemu Accept path. Drives the same `runQemuAcceptLoop` body the
// inline goroutine uses, fails the listener.Accept call by closing the
// listener mid-Accept, and asserts the sink received an event with
// source="listener.Accept" and a cause that contains the kernel's
// "use of closed network connection" error.
//
// Two-sided contract (verify by removing the line in
// runQemuAcceptLoop):
//
//	-		sink.Runtime("listener.Accept", err)
//
// Without that line, this test falls back to PollRuntime() returning
// nil and the assertion below red'd with "expected listener.Accept
// runtime error in sink, got nil — pre-fix silent return".
//
// This is the "不修真死" demonstration for ONE of the 5 silent sites
// the larger PR rewires. The other 4 sites (transport.AcceptVfkit,
// vn.AcceptVfkit, vn.AcceptQemu, and OverrideTCPHandler) share the
// identical pattern; lifting them into the same test shape is a
// straight grind (no design change) and is folded into the same PR's
// scope unless we choose to ship the framework first.
func TestRunQemuAcceptLoop_ListenerCloseSurfacesViaSink(t *testing.T) {
	socketPath := filepath.Join(t.TempDir(), "test-qemu.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatalf("listen failed: %v", err)
	}

	sink := NewErrSink(99)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		// vn is nil — we want to exercise only the listener.Accept path,
		// not the vn.AcceptQemu protocol layer (different test, different
		// failure mode).
		runQemuAcceptLoop(ctx, 99, listener, nil, sink)
		close(done)
	}()

	// Give the goroutine a moment to reach the Accept() syscall, then
	// close the listener out from under it. This triggers the
	// "use of closed network connection" path that, pre-fix, only
	// logged and returned silently.
	time.Sleep(20 * time.Millisecond)
	listener.Close()

	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("runQemuAcceptLoop did not return after listener close")
	}

	re := sink.PollRuntime()
	if re == nil {
		t.Fatal(
			"expected listener.Accept runtime error in sink, got nil — " +
				"pre-fix silent return: the goroutine logged the error and " +
				"vanished without anyone (including the Rust runtime) ever " +
				"observing it",
		)
	}
	if re.Source != "listener.Accept" {
		t.Errorf("source = %q, want %q", re.Source, "listener.Accept")
	}
	// The kernel + Go net package render closed-listener errors as
	// "use of closed network connection". Pin the substring so a future
	// Go version change that renames it surfaces here.
	if !strings.Contains(re.Err.Error(), "use of closed network connection") {
		t.Errorf(
			"cause %q should contain 'use of closed network connection' "+
				"(the kernel signal we're testing); got: %v",
			re.Err.Error(), re.Err,
		)
	}
}

// TestRunQemuAcceptLoop_CancelDoesNotSinkRuntime is the negative
// control: a planned shutdown (ctx cancelled before Accept returns)
// must NOT push to the sink — otherwise every gvproxy_destroy would
// pollute the runtime error queue with self-inflicted "closed
// connection" noise.
func TestRunQemuAcceptLoop_CancelDoesNotSinkRuntime(t *testing.T) {
	socketPath := filepath.Join(t.TempDir(), "test-cancel.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatalf("listen failed: %v", err)
	}

	sink := NewErrSink(100)
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan struct{})
	go func() {
		runQemuAcceptLoop(ctx, 100, listener, nil, sink)
		close(done)
	}()

	// Cancel FIRST, then close the listener. The goroutine should see
	// ctx.Err() != nil and skip sink.Runtime.
	time.Sleep(20 * time.Millisecond)
	cancel()
	listener.Close()

	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("runQemuAcceptLoop did not return after cancel + listener close")
	}

	if re := sink.PollRuntime(); re != nil {
		t.Errorf(
			"sink should be empty after planned shutdown (ctx cancelled); "+
				"got %s — runQemuAcceptLoop is reporting shutdown as a runtime error, "+
				"which would pollute the Rust-side error log on every gvproxy_destroy",
			re,
		)
	}
}

// TestRunQemuAcceptLoop_ProtocolErrorSurfacesViaSink covers the SECOND
// silent site on the Linux path: vn.AcceptQemu fails after Accept
// succeeded. Pre-fix: pump returns, ctx is still alive, no signal.
// Guest sees TCP RSTs on every packet.
//
// Drives the goroutine with a real listener + dialer (so Accept
// succeeds), then a mock acceptQemu that returns a synthetic error.
// Asserts sink got source="vn.AcceptQemu".
//
// Two-sided contract: remove the `sink.Runtime("vn.AcceptQemu", err)`
// line in runQemuAcceptLoop and this test reds with
// "expected vn.AcceptQemu runtime error in sink, got nil".
func TestRunQemuAcceptLoop_ProtocolErrorSurfacesViaSink(t *testing.T) {
	socketPath := filepath.Join(t.TempDir(), "test-proto.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatalf("listen failed: %v", err)
	}

	sink := NewErrSink(101)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	mockErr := errors.New("synthesized qemu protocol panic")
	acceptQemu := func(_ context.Context, _ net.Conn) error {
		return mockErr
	}

	done := make(chan struct{})
	go func() {
		runQemuAcceptLoop(ctx, 101, listener, acceptQemu, sink)
		close(done)
	}()

	// Connect so Accept succeeds and the loop reaches acceptQemu.
	clientConn, err := net.Dial("unix", socketPath)
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	defer clientConn.Close()

	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("runQemuAcceptLoop did not return after protocol error")
	}

	re := sink.PollRuntime()
	if re == nil {
		t.Fatal(
			"expected vn.AcceptQemu runtime error in sink, got nil — " +
				"pre-fix silent return: protocol pump errored but no signal " +
				"reached anyone (Rust runtime, operator, ops dashboard)",
		)
	}
	if re.Source != "vn.AcceptQemu" {
		t.Errorf("source = %q, want %q", re.Source, "vn.AcceptQemu")
	}
	if !errors.Is(re.Err, mockErr) {
		t.Errorf("cause should wrap mockErr; got: %v", re.Err)
	}
}
