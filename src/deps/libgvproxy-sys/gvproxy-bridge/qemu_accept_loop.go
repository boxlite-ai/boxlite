// runQemuAcceptLoop is the post-init Linux Qemu transport pump,
// extracted from the inline goroutine in `gvproxy_create` so tests can
// drive the same body against a real Unix socket + cancellable ctx +
// mock protocol function.
//
// Two distinct silent-failure sites (both pre-fix `logrus.Error +
// return`, now feeding `sink.Runtime`):
//
//  1. listener.Accept    — VM never connected, or listener was closed
//     out from under us. Pre-fix: gvproxy stays "alive" with no transport;
//     guest fails 20s later with "DNS lookup … i/o timeout".
//  2. acceptQemu         — the protocol pump itself errored. Pre-fix:
//     pump returns, ctx is still alive, no signal to anyone. Guest sees
//     every TCP packet RST.
//
// ctx cancellation is treated as planned shutdown (sink.Runtime is NOT
// invoked) — the call site cancels ctx during `gvproxy_destroy`, and we
// don't want shutdown to look like a runtime failure.
//
// `acceptQemu` is a function value (instead of taking *virtualnetwork.
// VirtualNetwork directly) so tests can inject failures without needing
// to construct a real VirtualNetwork. Production wiring in main.go
// passes `vn.AcceptQemu` as the function. nil means "skip the protocol
// stage", used by tests that only care about the listener.Accept path.

package main

import (
	"context"
	"net"

	"github.com/sirupsen/logrus"
)

// qemuProtocolFn matches `(*virtualnetwork.VirtualNetwork).AcceptQemu`.
type qemuProtocolFn func(ctx context.Context, conn net.Conn) error

func runQemuAcceptLoop(
	ctx context.Context,
	id int64,
	listener net.Listener,
	acceptQemu qemuProtocolFn,
	sink *ErrSink,
) {
	logrus.WithField("id", id).Trace("Waiting for Qemu connection on UnixStream socket")

	// Accept incoming connection (blocks until VM connects).
	acceptedConn, err := listener.Accept()
	if err != nil {
		if ctx.Err() == nil {
			logrus.WithFields(logrus.Fields{"error": err, "id": id}).Error("Failed to accept connection")
			sink.Runtime("listener.Accept", err)
		}
		return
	}

	logrus.WithFields(logrus.Fields{
		"id":     id,
		"remote": acceptedConn.RemoteAddr().String(),
	}).Info("Qemu connection accepted")

	// Close listener after first connection (one VM per gvproxy instance).
	listener.Close()

	// nil acceptQemu = test mode (validate only the listener.Accept path).
	if acceptQemu == nil {
		return
	}

	// Handle the Qemu protocol.
	if err := acceptQemu(ctx, acceptedConn); err != nil {
		if ctx.Err() == nil {
			logrus.WithFields(logrus.Fields{"error": err, "id": id}).Error("AcceptQemu error")
			sink.Runtime("vn.AcceptQemu", err)
		}
	}
}
