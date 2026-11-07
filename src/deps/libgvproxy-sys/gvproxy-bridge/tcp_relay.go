package main

import (
	"context"
	"net"
	"time"

	"github.com/boxlite-ai/tcprelay"
	"github.com/containers/gvisor-tap-vsock/pkg/tcpproxy"
	"github.com/sirupsen/logrus"
)

// relayTarget uses the upstream listener/router without its first-EOF cleanup.
// The instance owns the lifetime; the dial timeout ends before copying starts.
type relayTarget struct {
	ctx  context.Context
	addr string
	dial func(context.Context, string) (net.Conn, error)
}

func (t *relayTarget) HandleConn(client net.Conn) {
	defer client.Close()
	ctx, cancel := context.WithTimeout(t.ctx, 10*time.Second)
	guest, err := t.dial(ctx, t.addr)
	cancel()
	if err != nil {
		logrus.WithError(err).Debug("port forward dial failed")
		return
	}
	relayTCP(t.ctx, client, guest)
}

func relayTCP(ctx context.Context, left, right net.Conn) {
	peers := []net.Conn{left, right}
	for i, conn := range peers {
		if tcp, ok := tcpproxy.UnderlyingConn(conn).(*net.TCPConn); ok {
			_ = tcp.SetKeepAlive(true)
			_ = tcp.SetKeepAlivePeriod(time.Minute)
		}
		if buffered, ok := conn.(*tcpproxy.Conn); ok {
			// Read through the upstream wrapper to retain Peeked; close through
			// its underlying connection so CloseWrite remains available.
			peers[i] = &bufferedConn{Conn: buffered.Conn, reader: buffered}
		}
	}
	if err := tcprelay.Relay(ctx, peers[0], peers[1]); err != nil {
		logrus.WithError(err).Debug("TCP relay ended")
	}
}
