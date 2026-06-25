package main

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"
)

// TestRunVfkitAcceptLoop_TransportErrorSurfacesViaSink covers the
// silent transport.AcceptVfkit failure on macOS — pre-fix, the
// goroutine logged + returned and Rust got no signal. Drives the
// extracted loop with a mock transport that returns a synthetic error.
// Two-sided by toggling `sink.Runtime("transport.AcceptVfkit", err)`
// in runVfkitAcceptLoop.
func TestRunVfkitAcceptLoop_TransportErrorSurfacesViaSink(t *testing.T) {
	sink := NewErrSink(200)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	mockErr := errors.New("synthesized vfkit transport failure")
	acceptVfkitTransport := func(_ net.Conn) (net.Conn, error) {
		return nil, mockErr
	}

	done := make(chan struct{})
	go func() {
		runVfkitAcceptLoop(ctx, 200, nil, acceptVfkitTransport, nil, sink)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("runVfkitAcceptLoop did not return after transport failure")
	}

	re := sink.PollRuntime()
	if re == nil {
		t.Fatal(
			"expected transport.AcceptVfkit runtime error in sink, got nil — " +
				"pre-fix silent return: gvproxy alive but VFKit transport dead, " +
				"guest fails 20s later as DNS/network unreachable (same shape as #612)",
		)
	}
	if re.Source != "transport.AcceptVfkit" {
		t.Errorf("source = %q, want %q", re.Source, "transport.AcceptVfkit")
	}
	if !errors.Is(re.Err, mockErr) {
		t.Errorf("cause should wrap mockErr; got: %v", re.Err)
	}
}

// TestRunVfkitAcceptLoop_ProtocolErrorSurfacesViaSink covers the
// silent vn.AcceptVfkit failure on macOS — pre-fix, the protocol pump
// returned and no one knew. Drives the loop with a successful mock
// transport and a failing mock protocol, asserts sink got
// source="vn.AcceptVfkit".
//
// Two-sided contract: remove the `sink.Runtime("vn.AcceptVfkit", err)`
// line in runVfkitAcceptLoop and this test reds.
func TestRunVfkitAcceptLoop_ProtocolErrorSurfacesViaSink(t *testing.T) {
	sink := NewErrSink(201)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Mock the transport to return a fake "wrapped" connection — we
	// don't read/write it, so a closed pipe is fine.
	p1, p2 := net.Pipe()
	defer p1.Close()
	defer p2.Close()
	acceptVfkitTransport := func(_ net.Conn) (net.Conn, error) {
		return p1, nil
	}

	mockErr := errors.New("synthesized vfkit protocol panic")
	acceptVfkit := func(_ context.Context, _ net.Conn) error {
		return mockErr
	}

	done := make(chan struct{})
	go func() {
		runVfkitAcceptLoop(ctx, 201, nil, acceptVfkitTransport, acceptVfkit, sink)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("runVfkitAcceptLoop did not return after protocol failure")
	}

	re := sink.PollRuntime()
	if re == nil {
		t.Fatal(
			"expected vn.AcceptVfkit runtime error in sink, got nil — " +
				"pre-fix silent return: VFKit protocol pump died, guest TCP " +
				"connections RST silently",
		)
	}
	if re.Source != "vn.AcceptVfkit" {
		t.Errorf("source = %q, want %q", re.Source, "vn.AcceptVfkit")
	}
	if !errors.Is(re.Err, mockErr) {
		t.Errorf("cause should wrap mockErr; got: %v", re.Err)
	}
}

// TestRunVfkitAcceptLoop_CancelDoesNotSinkRuntime is the negative
// control mirror of the Qemu cancel test. Planned shutdown via ctx
// cancel must not pollute the runtime queue.
func TestRunVfkitAcceptLoop_CancelDoesNotSinkRuntime(t *testing.T) {
	sink := NewErrSink(202)
	ctx, cancel := context.WithCancel(context.Background())

	mockErr := errors.New("synthesized transport failure during planned shutdown")
	acceptVfkitTransport := func(_ net.Conn) (net.Conn, error) {
		// Block until ctx is cancelled, then return an error (mirroring
		// what happens when the underlying socket is closed during
		// shutdown — the syscall returns "closed" but ctx is already done).
		<-ctx.Done()
		return nil, mockErr
	}

	done := make(chan struct{})
	go func() {
		runVfkitAcceptLoop(ctx, 202, nil, acceptVfkitTransport, nil, sink)
		close(done)
	}()

	time.Sleep(20 * time.Millisecond)
	cancel() // planned shutdown

	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("runVfkitAcceptLoop did not return after planned cancel")
	}

	if re := sink.PollRuntime(); re != nil {
		t.Errorf(
			"sink should be empty after planned shutdown (ctx cancelled); "+
				"got %s — runVfkitAcceptLoop is reporting shutdown as runtime error",
			re,
		)
	}
}
