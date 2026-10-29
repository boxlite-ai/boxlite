package main

import (
	"context"
	"net"
	"testing"
	"testing/synctest"
	"time"

	"github.com/containers/gvisor-tap-vsock/pkg/tcpproxy"
)

// SSH channel closure can wait for the remote transport. Its compatibility
// path must still return after the first copy without joining that Close.
type delayedCloseConn struct {
	*idleTestConn
	release <-chan struct{}
}

func (c *delayedCloseConn) Close() error {
	<-c.release
	return c.idleTestConn.Close()
}

func TestDialProxyLegacyCloseDoesNotWaitForPeer(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		client, left := idleTestPair()
		right, peer := idleTestPair()
		release := make(chan struct{})
		defer func() {
			close(release)
			client.Close()
			peer.Close()
			synctest.Wait()
		}()
		proxy := &tcpproxy.DialProxy{
			LegacyCloseOnEOF: true,
			DialContext: func(context.Context, string, string) (net.Conn, error) {
				return &delayedCloseConn{idleTestConn: right, release: release}, nil
			},
		}
		done := make(chan struct{})
		go func() { proxy.HandleConn(left); close(done) }()
		client.CloseWrite()
		synctest.Wait()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("legacy relay waited for remote channel close")
		}
	})
}
