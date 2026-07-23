package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// --- Detection Tests ---

func TestIsWebSocketUpgrade_True(t *testing.T) {
	req := httptest.NewRequest("GET", "/ws", nil)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")

	if !isWebSocketUpgrade(req) {
		t.Error("expected true for valid WebSocket upgrade request")
	}
}

func TestIsWebSocketUpgrade_False_NoUpgrade(t *testing.T) {
	req := httptest.NewRequest("GET", "/api", nil)

	if isWebSocketUpgrade(req) {
		t.Error("expected false for normal GET request")
	}
}

func TestIsWebSocketUpgrade_False_NotWebSocket(t *testing.T) {
	req := httptest.NewRequest("GET", "/h2c", nil)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "h2c")

	if isWebSocketUpgrade(req) {
		t.Error("expected false for h2c upgrade (not websocket)")
	}
}

func TestIsWebSocketUpgrade_CaseInsensitive(t *testing.T) {
	req := httptest.NewRequest("GET", "/ws", nil)
	req.Header.Set("Connection", "upgrade")
	req.Header.Set("Upgrade", "WebSocket")

	if !isWebSocketUpgrade(req) {
		t.Error("expected true for case-insensitive WebSocket upgrade")
	}
}

// --- Handler Tests ---

func TestHandleWebSocketUpgrade_HeaderSubstitution(t *testing.T) {
	secrets := []SecretConfig{
		{
			Name:        "apikey",
			Hosts:       []string{"ws.example.com"},
			Placeholder: "<BOXLITE_SECRET:apikey>",
			Value:       "secret-api-key",
		},
	}

	// Start a TLS upstream server that reads the HTTP upgrade request and captures headers
	ca := newTestCA(t)
	upstreamCert, err := ca.GenerateHostCert("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}

	receivedAuth := make(chan string, 1)
	rawLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	upstreamLn := tls.NewListener(rawLn, &tls.Config{
		Certificates: []tls.Certificate{*upstreamCert},
	})
	defer upstreamLn.Close()

	go func() {
		conn, err := upstreamLn.Accept()
		if err != nil {
			return
		}
		defer conn.Close()

		reader := bufio.NewReader(conn)
		req, err := http.ReadRequest(reader)
		if err != nil {
			receivedAuth <- "ERROR: " + err.Error()
			return
		}
		receivedAuth <- req.Header.Get("Authorization")

		// Send back a minimal 101 response
		resp := "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"
		conn.Write([]byte(resp))
	}()

	destAddr := upstreamLn.Addr().String()
	insecureTLS := &tls.Config{InsecureSkipVerify: true}

	// Create a test HTTP server that uses handleWebSocketUpgrade
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handleWebSocketUpgrade(w, r, destAddr, secrets, insecureTLS)
	})
	srv := httptest.NewServer(handler)
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Send a WebSocket upgrade request with a secret placeholder in Authorization
	req, err := http.NewRequestWithContext(ctx, "GET", srv.URL+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Authorization", "Bearer <BOXLITE_SECRET:apikey>")

	// Use raw transport to prevent Go from handling the upgrade
	transport := &http.Transport{}
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatal("request failed:", err)
	}
	defer resp.Body.Close()

	// Check what the upstream server received
	select {
	case auth := <-receivedAuth:
		if auth != "Bearer secret-api-key" {
			t.Errorf("expected upstream to receive 'Bearer secret-api-key', got %q", auth)
		}
	case <-ctx.Done():
		t.Fatal("timeout waiting for upstream to receive request")
	}
}

func TestHandleWebSocketUpgrade_BidirectionalRelay(t *testing.T) {
	secrets := []SecretConfig{}

	// Start a TLS echo server (reads a line, writes it back)
	ca := newTestCA(t)
	upstreamCert, err := ca.GenerateHostCert("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}

	rawLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	upstreamLn := tls.NewListener(rawLn, &tls.Config{
		Certificates: []tls.Certificate{*upstreamCert},
	})
	defer upstreamLn.Close()

	go func() {
		conn, err := upstreamLn.Accept()
		if err != nil {
			return
		}
		defer conn.Close()

		reader := bufio.NewReader(conn)
		_, err = http.ReadRequest(reader)
		if err != nil {
			return
		}

		resp := "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"
		conn.Write([]byte(resp))

		// Echo loop
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				return
			}
			_, err = fmt.Fprint(conn, line)
			if err != nil {
				return
			}
		}
	}()

	destAddr := upstreamLn.Addr().String()
	insecureTLS := &tls.Config{InsecureSkipVerify: true}

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handleWebSocketUpgrade(w, r, destAddr, secrets, insecureTLS)
	})
	srv := httptest.NewServer(handler)
	defer srv.Close()

	// Connect to the test server using raw TCP
	srvAddr := strings.TrimPrefix(srv.URL, "http://")
	conn, err := net.DialTimeout("tcp", srvAddr, 5*time.Second)
	if err != nil {
		t.Fatal("failed to connect:", err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(5 * time.Second))

	// Send WebSocket upgrade request
	upgradeReq := "GET /ws HTTP/1.1\r\nHost: ws.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"
	_, err = io.WriteString(conn, upgradeReq)
	if err != nil {
		t.Fatal("failed to send upgrade:", err)
	}

	reader := bufio.NewReader(conn)

	// Read upgrade response
	resp, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal("failed to read upgrade response:", err)
	}

	if resp.StatusCode != http.StatusSwitchingProtocols {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("expected 101 Switching Protocols, got %d: %s", resp.StatusCode, string(body))
	}

	// Now the connection is "upgraded" — send a line and expect echo
	_, err = fmt.Fprint(conn, "hello\n")
	if err != nil {
		t.Fatal("failed to send data:", err)
	}

	line, err := reader.ReadString('\n')
	if err != nil {
		t.Fatal("failed to read echo:", err)
	}

	if strings.TrimSpace(line) != "hello" {
		t.Errorf("expected echo 'hello', got %q", strings.TrimSpace(line))
	}
}
