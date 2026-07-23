package main

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"net"
	"testing"
)

func TestPeekSNI_ExtractsSNI(t *testing.T) {
	// Create a real TLS ClientHello via net.Pipe + tls.Client
	clientConn, serverConn := net.Pipe()
	defer serverConn.Close()

	go func() {
		defer clientConn.Close()
		tlsConn := tls.Client(clientConn, &tls.Config{
			ServerName:         "api.openai.com",
			InsecureSkipVerify: true,
		})
		tlsConn.Handshake() //nolint:errcheck // expected to fail
	}()

	br := bufio.NewReaderSize(serverConn, 16384)
	sni := peekClientHelloSNI(br)
	if sni != "api.openai.com" {
		t.Errorf("expected SNI 'api.openai.com', got %q", sni)
	}

	// Verify Peek didn't consume bytes
	if br.Buffered() == 0 {
		t.Error("bufio.Reader should still have buffered bytes after Peek")
	}
}

func TestPeekSNI_DifferentHostname(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer serverConn.Close()

	go func() {
		defer clientConn.Close()
		tlsConn := tls.Client(clientConn, &tls.Config{
			ServerName:         "api.anthropic.com",
			InsecureSkipVerify: true,
		})
		tlsConn.Handshake() //nolint:errcheck
	}()

	br := bufio.NewReaderSize(serverConn, 16384)
	sni := peekClientHelloSNI(br)
	if sni != "api.anthropic.com" {
		t.Errorf("expected SNI 'api.anthropic.com', got %q", sni)
	}
}

func TestPeekSNI_NotTLS(t *testing.T) {
	data := []byte("GET / HTTP/1.1\r\nHost: example.com\r\n\r\n")
	br := bufio.NewReader(bytes.NewReader(data))
	sni := peekClientHelloSNI(br)
	if sni != "" {
		t.Errorf("expected empty SNI for HTTP data, got %q", sni)
	}
}

func TestPeekSNI_EmptyInput(t *testing.T) {
	br := bufio.NewReader(bytes.NewReader(nil))
	sni := peekClientHelloSNI(br)
	if sni != "" {
		t.Errorf("expected empty SNI for empty input, got %q", sni)
	}
}

func TestPeekHTTPHost_ExtractsHost(t *testing.T) {
	data := []byte("GET / HTTP/1.1\r\nHost: example.com\r\n\r\n")
	br := bufio.NewReader(bytes.NewReader(data))
	host := peekHTTPHost(br)
	if host != "example.com" {
		t.Errorf("expected 'example.com', got %q", host)
	}
}

func TestPeekHTTPHost_WithPort(t *testing.T) {
	data := []byte("GET / HTTP/1.1\r\nHost: example.com:8080\r\n\r\n")
	br := bufio.NewReader(bytes.NewReader(data))
	host := peekHTTPHost(br)
	if host != "example.com" {
		t.Errorf("expected 'example.com' (port stripped), got %q", host)
	}
}

func TestPeekHTTPHost_CaseInsensitive(t *testing.T) {
	data := []byte("GET / HTTP/1.1\r\nHost: API.OpenAI.COM\r\n\r\n")
	br := bufio.NewReader(bytes.NewReader(data))
	host := peekHTTPHost(br)
	if host != "api.openai.com" {
		t.Errorf("expected lowercase 'api.openai.com', got %q", host)
	}
}

func TestPeekHTTPHost_NotHTTP(t *testing.T) {
	// TLS record header (not HTTP)
	data := []byte{0x16, 0x03, 0x01, 0x00, 0x05, 0x01, 0x00, 0x00, 0x01, 0x03}
	br := bufio.NewReader(bytes.NewReader(data))
	host := peekHTTPHost(br)
	if host != "" {
		t.Errorf("expected empty for TLS data, got %q", host)
	}
}

func TestPeekHTTPHost_EmptyInput(t *testing.T) {
	br := bufio.NewReader(bytes.NewReader(nil))
	host := peekHTTPHost(br)
	if host != "" {
		t.Errorf("expected empty for empty input, got %q", host)
	}
}

func TestPeekHTTPHost_POST(t *testing.T) {
	data := []byte("POST /api/v1/chat HTTP/1.1\r\nHost: api.openai.com\r\nContent-Type: application/json\r\n\r\n{}")
	br := bufio.NewReader(bytes.NewReader(data))
	host := peekHTTPHost(br)
	if host != "api.openai.com" {
		t.Errorf("expected 'api.openai.com', got %q", host)
	}
}
