package proxy

import (
	"bufio"
	"io"
	"net"
	"testing"
	"time"
)

func TestProxyBidirectionalStreamRelaysBothDirections(t *testing.T) {
	client, proxyClient := net.Pipe()
	proxyGuest, guest := net.Pipe()
	defer client.Close()
	defer guest.Close()

	done := make(chan struct{})
	go func() {
		ProxyBidirectionalStream(proxyClient, proxyGuest)
		close(done)
	}()

	for _, exchange := range []struct {
		writer net.Conn
		reader net.Conn
		data   string
	}{{client, guest, "request"}, {guest, client, "response"}} {
		go exchange.writer.Write([]byte(exchange.data))
		payload := make([]byte, len(exchange.data))
		if _, err := io.ReadFull(exchange.reader, payload); err != nil {
			t.Fatal(err)
		}
		if string(payload) != exchange.data {
			t.Fatalf("payload = %q, want %q", payload, exchange.data)
		}
	}

	client.Close()
	guest.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("stream relay did not stop")
	}
}

func TestBufferedConnPreservesBufferedBytes(t *testing.T) {
	conn, peer := net.Pipe()
	defer conn.Close()
	defer peer.Close()

	reader := bufio.NewReader(conn)
	go peer.Write([]byte("buffered"))
	if _, err := reader.Peek(1); err != nil {
		t.Fatal(err)
	}

	payload := make([]byte, len("buffered"))
	if _, err := io.ReadFull(NewBufferedConn(conn, reader), payload); err != nil {
		t.Fatal(err)
	}
	if string(payload) != "buffered" {
		t.Fatalf("payload = %q", payload)
	}
}
