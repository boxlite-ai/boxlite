package main

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func tunnelTCPPair(t *testing.T) (*net.TCPConn, *net.TCPConn) {
	t.Helper()
	listener, err := net.ListenTCP("tcp", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	client, err := net.DialTCP("tcp", nil, listener.Addr().(*net.TCPAddr))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close() })
	server, err := listener.AcceptTCP()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { server.Close() })
	client.SetDeadline(time.Now().Add(3 * time.Second))
	server.SetDeadline(time.Now().Add(3 * time.Second))
	return client, server
}

func awaitTunnelClosed(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("tunnel handler did not finish")
	}
}

func TestControlTunnelPreservesHalfClose(t *testing.T) {
	for _, first := range []string{"client", "guest"} {
		t.Run(first, func(t *testing.T) {
			upstream, guest := tunnelTCPPair(t)
			done := make(chan struct{})
			handler := dialFirstTunnel(func(context.Context, string) (net.Conn, error) { return upstream, nil })
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer close(done)
				handler(w, r)
			}))
			defer server.Close()
			conn, ack := tunnelHandshake(t, server, time.Second)
			if ack != "OK" {
				t.Fatalf("tunnel ack = %q", ack)
			}
			client := conn.(*net.TCPConn)
			client.SetDeadline(time.Now().Add(3 * time.Second))
			sender, receiver := client, guest
			if first == "guest" {
				sender, receiver = guest, client
			}
			if _, err := io.WriteString(sender, "request"); err != nil {
				t.Fatal(err)
			}
			if err := sender.CloseWrite(); err != nil {
				t.Fatal(err)
			}
			request, err := io.ReadAll(receiver)
			if err != nil || string(request) != "request" {
				t.Fatalf("request = %q, error = %v", request, err)
			}
			// Reply only after FIN has traversed the production adapter.
			if _, err := io.WriteString(receiver, "response after EOF"); err != nil {
				t.Fatal(err)
			}
			if err := receiver.CloseWrite(); err != nil {
				t.Fatal(err)
			}
			response, err := io.ReadAll(sender)
			if err != nil || string(response) != "response after EOF" {
				t.Fatalf("response = %q, error = %v", response, err)
			}
			awaitTunnelClosed(t, done)
		})
	}
}

func TestControlTunnelStopsOnCancellation(t *testing.T) {
	upstream, guest := tunnelTCPPair(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	handler := dialFirstTunnel(func(context.Context, string) (net.Conn, error) { return upstream, nil })
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(done)
		handler(w, r)
	}))
	server.Config.BaseContext = func(net.Listener) context.Context { return ctx }
	server.Start()
	defer server.Close()
	client, ack := tunnelHandshake(t, server, time.Second)
	if ack != "OK" {
		t.Fatalf("tunnel ack = %q", ack)
	}
	client.SetDeadline(time.Now().Add(3 * time.Second))
	cancel()
	awaitTunnelClosed(t, done)
	for _, conn := range []net.Conn{client, guest} {
		data, err := io.ReadAll(conn)
		if err != nil || len(data) != 0 {
			t.Fatalf("canceled tunnel read = %q, error = %v", data, err)
		}
	}
}

func TestControlTunnelPreservesBufferedPayload(t *testing.T) {
	client, relay := tunnelTCPPair(t)
	upstream, guest := tunnelTCPPair(t)
	// Model bytes already read by HTTP; subsequent reads must use relay.
	reader := bufio.NewReader(strings.NewReader("buffered"))
	if _, err := reader.Peek(len("buffered")); err != nil {
		t.Fatal(err)
	}
	writer := hijackWriter{httptest.NewRecorder(), func() (net.Conn, *bufio.ReadWriter, error) {
		return relay, bufio.NewReadWriter(reader, bufio.NewWriter(relay)), nil
	}}
	done := make(chan struct{})
	handler := dialFirstTunnel(func(context.Context, string) (net.Conn, error) { return upstream, nil })
	go func() {
		defer close(done)
		handler(writer, httptest.NewRequest(http.MethodPost, "/tunnel?ip=127.0.0.1&port=80", nil))
	}()
	ack := make([]byte, 2)
	if _, err := io.ReadFull(client, ack); err != nil || string(ack) != "OK" {
		t.Fatalf("tunnel ack = %q, error = %v", ack, err)
	}
	if _, err := io.WriteString(client, "-raw"); err != nil {
		t.Fatal(err)
	}
	payload := make([]byte, len("buffered-raw"))
	if _, err := io.ReadFull(guest, payload); err != nil || string(payload) != "buffered-raw" {
		t.Fatalf("guest payload = %q, error = %v", payload, err)
	}
	client.Close()
	guest.Close()
	awaitTunnelClosed(t, done)
}
