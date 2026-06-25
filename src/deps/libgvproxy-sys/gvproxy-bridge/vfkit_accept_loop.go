// runVfkitAcceptLoop is the post-init macOS VFKit transport pump,
// extracted from the inline goroutine in `gvproxy_create` so tests can
// drive the same body against a real Unix DGRAM socket + cancellable
// ctx + mock protocol/transport functions.
//
// Two distinct silent-failure sites (both pre-fix `logrus.Error +
// return`, now feeding `sink.Runtime`):
//
//  1. transport.AcceptVfkit — VM never connected, or the DGRAM socket
//     was closed out from under us. Pre-fix: gvproxy stays "alive" with
//     no transport; guest fails 20s later as DNS/network unreachable.
//  2. acceptVfkit          — the VFKit protocol pump itself errored.
//     Pre-fix: pump returns, ctx is still alive, no signal to anyone.
//     Guest sees TCP RSTs.
//
// ctx cancellation is treated as planned shutdown (sink.Runtime is NOT
// invoked) — the call site cancels ctx during `gvproxy_destroy`.
//
// `acceptVfkitTransport` and `acceptVfkit` are function values so tests
// can inject failures without needing macOS-only transport infrastructure
// or a real VirtualNetwork. nil acceptVfkit = "skip the protocol stage",
// used by tests focused on the transport.AcceptVfkit path only.
//
// Although this only fires on macOS in production (the call site is
// gated by `runtime.GOOS == "darwin"`), the source compiles on every
// platform so the test suite runs everywhere.

package main

import (
	"context"
	"net"

	"github.com/sirupsen/logrus"
)

// vfkitTransportFn matches `transport.AcceptVfkit(net.Conn) (net.Conn, error)`.
// Upstream signature takes the generic net.Conn interface even though VFKit
// in production is always a *net.UnixConn — the wider type lets tests pass
// any net.Conn implementation.
type vfkitTransportFn func(conn net.Conn) (net.Conn, error)

// vfkitProtocolFn matches `(*virtualnetwork.VirtualNetwork).AcceptVfkit`.
type vfkitProtocolFn func(ctx context.Context, conn net.Conn) error

func runVfkitAcceptLoop(
	ctx context.Context,
	id int64,
	conn net.Conn,
	acceptVfkitTransport vfkitTransportFn,
	acceptVfkit vfkitProtocolFn,
	sink *ErrSink,
) {
	logrus.WithField("id", id).Trace("Waiting for VFKit connection on UnixDgram socket")

	// Wait for incoming connection and get wrapped connection with remote address.
	// AcceptVfkit peeks at the first packet to get the remote address.
	wrappedConn, err := acceptVfkitTransport(conn)
	if err != nil {
		if ctx.Err() == nil {
			logrus.WithFields(logrus.Fields{"error": err, "id": id}).Error("Failed to accept VFKit connection")
			sink.Runtime("transport.AcceptVfkit", err)
		}
		return
	}

	logrus.WithFields(logrus.Fields{
		"id":     id,
		"remote": wrappedConn.RemoteAddr().String(),
	}).Info("VFKit connection accepted")

	// nil acceptVfkit = test mode.
	if acceptVfkit == nil {
		return
	}

	// Handle the VFKit protocol with the wrapped connection.
	if err := acceptVfkit(ctx, wrappedConn); err != nil {
		if ctx.Err() == nil {
			logrus.WithFields(logrus.Fields{"error": err, "id": id}).Error("AcceptVfkit error")
			sink.Runtime("vn.AcceptVfkit", err)
		}
	}
}
