package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/containers/gvisor-tap-vsock/pkg/types"
	"github.com/containers/gvisor-tap-vsock/pkg/virtualnetwork"
)

// tunnelHandshake speaks the control socket's /tunnel handshake, as the
// boxlite core does, and returns the connection with the first reply bytes.
func tunnelHandshake(t *testing.T, server *httptest.Server, wait time.Duration) (net.Conn, string) {
	t.Helper()
	conn, err := net.Dial("tcp", strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	if _, err := io.WriteString(conn, "POST /tunnel?ip=192.168.127.2&port=18080 HTTP/1.1\r\nHost: gvproxy\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	if err := conn.SetReadDeadline(time.Now().Add(wait)); err != nil {
		t.Fatal(err)
	}
	reply := make([]byte, 12)
	n, _ := io.ReadFull(conn, reply[:2])
	if n == 2 && string(reply[:2]) != "OK" {
		m, _ := io.ReadFull(conn, reply[2:])
		n += m
	}
	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		t.Fatal(err)
	}
	return conn, string(reply[:n])
}

func newControlTestNetwork(t *testing.T) *virtualnetwork.VirtualNetwork {
	t.Helper()
	vn, err := virtualnetwork.New(&types.Configuration{
		Subnet:            "192.168.127.0/24",
		GatewayIP:         "192.168.127.1",
		GatewayMacAddress: "5a:94:ef:e4:0c:dd",
		DHCPStaticLeases:  map[string]string{},
		NAT:               map[string]string{},
		Forwards:          map[string]string{},
		GatewayVirtualIPs: []string{"192.168.127.1"},
		Protocol:          types.VfkitProtocol,
	})
	if err != nil {
		t.Fatalf("virtualnetwork.New() failed: %v", err)
	}
	return vn
}

// A preview request to a resumed box arrives before its cmd listens, and the
// proxy retries only while the dial fails. gvproxy's own /tunnel acks "OK"
// before it dials the guest, so the guest's answer never reached the caller.
// The control socket must not ack a guest that has not accepted.
func TestControlTunnelDoesNotAckBeforeTheGuestAccepts(t *testing.T) {
	vn := newControlTestNetwork(t)
	server := httptest.NewServer(controlMux(vn.ServicesMux(), vn.DialContextTCP))
	defer server.Close()

	// No VM is attached, so the guest never answers the dial.
	conn, reply := tunnelHandshake(t, server, 500*time.Millisecond)
	// Hanging up cancels the pending dial, as the core's handshake timeout does.
	conn.Close()

	if reply == "OK" {
		t.Fatal("control socket acked a tunnel before the guest accepted it")
	}
}

func TestControlTunnelReportsARefusedGuestPort(t *testing.T) {
	vn := newControlTestNetwork(t)
	server := httptest.NewServer(controlMux(vn.ServicesMux(), func(context.Context, string) (net.Conn, error) {
		return nil, syscall.ECONNREFUSED
	}))
	defer server.Close()

	conn, reply := tunnelHandshake(t, server, 2*time.Second)
	conn.Close()

	if !strings.HasPrefix(reply, "HTTP/1.1 502") {
		t.Fatalf("reply = %q, want an HTTP 502 instead of the OK ack", reply)
	}
}

func TestControlTunnelRelaysAnAcceptedGuestConnection(t *testing.T) {
	vn := newControlTestNetwork(t)
	var dialed atomic.Value
	dialed.Store("")
	server := httptest.NewServer(controlMux(vn.ServicesMux(), func(_ context.Context, addr string) (net.Conn, error) {
		dialed.Store(addr)
		guest, peer := net.Pipe()
		go func() {
			defer peer.Close()
			_, _ = io.Copy(peer, peer)
		}()
		return guest, nil
	}))
	defer server.Close()

	conn, reply := tunnelHandshake(t, server, 2*time.Second)
	if reply != "OK" || dialed.Load() != "192.168.127.2:18080" {
		conn.Close()
		t.Fatalf("reply %q after dialing %q; want OK after dialing 192.168.127.2:18080", reply, dialed.Load())
	}
	if err := conn.SetDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(conn, "ping"); err != nil {
		t.Fatal(err)
	}
	echo := make([]byte, 4)
	_, err := io.ReadFull(conn, echo)
	conn.Close()
	if err != nil || string(echo) != "ping" {
		t.Fatalf("echo = %q, %v; want ping", echo, err)
	}
}

// The core only ever POSTs /tunnel. gvproxy's own /tunnel ignores the method, so
// a stray GET would dial the guest; the replacement refuses it before dialing.
func TestControlTunnelRejectsAMethodOtherThanPost(t *testing.T) {
	vn := newControlTestNetwork(t)
	var dialed atomic.Bool
	server := httptest.NewServer(controlMux(vn.ServicesMux(), func(context.Context, string) (net.Conn, error) {
		dialed.Store(true)
		return nil, syscall.ECONNREFUSED
	}))
	defer server.Close()

	response, err := http.Get(server.URL + "/tunnel?ip=192.168.127.2&port=18080")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()

	if response.StatusCode != http.StatusMethodNotAllowed || dialed.Load() {
		t.Fatalf("GET /tunnel = %d, dialed %v; want 405 without a guest dial", response.StatusCode, dialed.Load())
	}
}
