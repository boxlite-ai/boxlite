//go:build unix

package boxlite

import (
	"context"
	"errors"
	"testing"
)

func TestNetworkTunnelRejectsClosedHandle(t *testing.T) {
	var network *Network
	if _, err := network.Tunnel(context.Background(), 3000); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("Tunnel() error = %v, want ErrRuntimeClosed", err)
	}
}

func TestBoxNetworkRejectsClosedHandle(t *testing.T) {
	var box *Box
	if _, err := box.Network(); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("Network() error = %v, want ErrRuntimeClosed", err)
	}
}

func TestTunnelMethodsRejectClosedHandle(t *testing.T) {
	var tunnel *BoxTunnel
	if _, err := tunnel.Endpoint(); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("Endpoint() error = %v, want ErrRuntimeClosed", err)
	}
	if _, err := tunnel.Connect(context.Background()); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("Connect() error = %v, want ErrRuntimeClosed", err)
	}
}

func TestNetworkAndTunnelCloseAreIdempotent(t *testing.T) {
	if err := (&Network{}).Close(); err != nil {
		t.Fatalf("Network.Close() error = %v", err)
	}
	if err := (&BoxTunnel{}).Close(); err != nil {
		t.Fatalf("Tunnel.Close() error = %v", err)
	}
}
