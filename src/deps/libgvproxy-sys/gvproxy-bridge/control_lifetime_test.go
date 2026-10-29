package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestControlServerCancelsHijackedTunnel(t *testing.T) {
	upstream, guest := tunnelTCPPair(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	handlerDone := make(chan struct{})
	handler := dialFirstTunnel(func(context.Context, string) (net.Conn, error) { return upstream, nil })
	serverDone := make(chan struct{})
	go func() {
		defer close(serverDone)
		_ = serveControl(ctx, listener, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer close(handlerDone)
			handler(w, r)
		}))
	}()
	defer func() { listener.Close(); <-serverDone }()
	client, ack := tunnelHandshake(t, &httptest.Server{URL: "http://" + listener.Addr().String()}, time.Second)
	defer client.Close()
	defer guest.Close()
	if ack != "OK" {
		t.Fatalf("ack = %q", ack)
	}
	cancel()
	awaitTunnelClosed(t, handlerDone)
	for _, conn := range []net.Conn{client, guest} {
		conn.SetReadDeadline(time.Now().Add(time.Second))
		if body, err := io.ReadAll(conn); err != nil || len(body) != 0 {
			t.Fatalf("canceled tunnel read = %q, error = %v", body, err)
		}
	}
}
