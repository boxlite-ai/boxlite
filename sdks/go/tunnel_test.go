//go:build unix

package boxlite

import (
	"context"
	"errors"
	"net"
	"path/filepath"
	"testing"
)

func TestNetworkTunnelRejectsClosedHandle(t *testing.T) {
	var network *Network
	if _, err := network.Tunnel(context.Background(), 3000); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("Tunnel() error = %v, want ErrRuntimeClosed", err)
	}
}

func TestTunnelForwardRejectsClosedHandle(t *testing.T) {
	var tunnel *BoxTunnel
	listen, err := TCPListenAddress("", 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tunnel.Forward(context.Background(), listen); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("Forward() error = %v, want ErrRuntimeClosed", err)
	}
}

func TestListenAddressHelpersReturnStandardAddresses(t *testing.T) {
	tcp, err := TCPListenAddress("", 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := tcp.(*net.TCPAddr); !ok {
		t.Fatalf("TCPListenAddress() = %T, want *net.TCPAddr", tcp)
	}

	unix, err := UnixListenAddress(filepath.Join(t.TempDir(), "app.sock"))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := unix.(*net.UnixAddr); !ok {
		t.Fatalf("UnixListenAddress() = %T, want *net.UnixAddr", unix)
	}
}

func TestListenAddressValidation(t *testing.T) {
	if _, err := TCPListenAddress("localhost", 8080); err == nil {
		t.Fatal("hostname must be rejected")
	}
	if _, err := UnixListenAddress("relative.sock"); err == nil {
		t.Fatal("relative Unix path must be rejected")
	}
	if _, err := UnixListenAddress("/tmp/app\x00.sock"); err == nil {
		t.Fatal("Unix path containing NUL must be rejected")
	}
	if _, err := parseListenAddress(&net.UDPAddr{}); err == nil {
		t.Fatal("UDP address must be rejected")
	}
	if _, err := parseListenAddress(&net.UnixAddr{Name: "/tmp/app.sock", Net: "unixgram"}); err == nil {
		t.Fatal("Unix datagram address must be rejected")
	}
	if _, err := parseListenAddress(&net.UnixAddr{Name: "/tmp/app\x00.sock", Net: "unix"}); err == nil {
		t.Fatal("generic Unix address containing NUL must be rejected")
	}
}

func TestTunnelForwarderMethodsHandleClosedValue(t *testing.T) {
	var forwarder *TunnelForwarder
	if forwarder.Addr() != nil {
		t.Fatal("Addr() must be nil for a closed forwarder")
	}
	if err := forwarder.Wait(context.Background()); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("Wait() error = %v, want ErrRuntimeClosed", err)
	}
	if err := forwarder.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
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
	if _, err := tunnel.URI(); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("URI() error = %v, want ErrRuntimeClosed", err)
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

func TestRuntimeDoesNotStartDrainAfterClosing(t *testing.T) {
	closing := make(chan struct{})
	close(closing)
	runtime := &Runtime{closing: closing}

	runtime.ensureDrainRunning()

	if runtime.drainStop != nil {
		runtime.stopDrain()
		t.Fatal("ensureDrainRunning() started a drain after runtime closure")
	}
}
