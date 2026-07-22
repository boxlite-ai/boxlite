// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

package proxy

import (
	"bufio"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type connectResponseWriter struct {
	http.ResponseWriter
	conn net.Conn
}

func (w *connectResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return w.conn, bufio.NewReadWriter(bufio.NewReader(w.conn), bufio.NewWriter(w.conn)), nil
}

func TestAcceptConnectWritesHandshake(t *testing.T) {
	server, client := net.Pipe()
	defer client.Close()
	result := make(chan net.Conn, 1)
	go func() {
		conn, err := AcceptConnect(&connectResponseWriter{ResponseWriter: httptest.NewRecorder(), conn: server})
		if err == nil {
			result <- conn
		}
	}()

	if err := client.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	response, err := bufio.NewReader(client).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(response) != "HTTP/1.1 200 Connection Established" {
		t.Fatalf("response = %q", response)
	}
	conn := <-result
	conn.Close()
}

func TestAcceptConnectRejectsUnsupportedWriter(t *testing.T) {
	recorder := httptest.NewRecorder()
	if _, err := AcceptConnect(recorder); err == nil {
		t.Fatal("expected hijacking error")
	}
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", recorder.Code)
	}
}
