// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

package proxy

import (
	"bufio"
	"context"
	"errors"
	"io"
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

func TestAcceptConnectPreservesHalfCloseAndCancellation(t *testing.T) {
	for _, cancelAfterEOF := range []bool{false, true} {
		name := "reply after EOF"
		if cancelAfterEOF {
			name = "cancel after EOF"
		}
		t.Run(name, func(t *testing.T) {
			upstream, guest := tcpConnPair(t)
			defer upstream.Close()
			defer guest.Close()
			deadline := time.Now().Add(3 * time.Second)
			upstream.SetDeadline(deadline)
			guest.SetDeadline(deadline)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := AcceptConnect(w)
				if err != nil {
					done <- err
					return
				}
				defer conn.Close()
				conn.SetDeadline(deadline)
				done <- ProxyBidirectionalStream(r.Context(), conn, upstream)
			}))
			server.Config.BaseContext = func(net.Listener) context.Context { return ctx }
			server.Start()
			defer server.Close()
			client, err := net.Dial("tcp", server.Listener.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			client.SetDeadline(deadline)
			if _, err := io.WriteString(client, "CONNECT guest:80 HTTP/1.1\r\nHost: guest:80\r\n\r\n"); err != nil {
				t.Fatal(err)
			}
			reader := bufio.NewReader(client)
			response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodConnect})
			if err != nil || response.StatusCode != http.StatusOK {
				t.Fatalf("CONNECT response = %v, error = %v", response, err)
			}
			if _, err := io.WriteString(client, "request"); err != nil {
				t.Fatal(err)
			}
			if err := client.(*net.TCPConn).CloseWrite(); err != nil {
				t.Fatal(err)
			}
			request, err := io.ReadAll(guest)
			if err != nil || string(request) != "request" {
				t.Fatalf("guest request = %q, error = %v", request, err)
			}
			want := "response after EOF"
			if cancelAfterEOF {
				cancel()
				want = ""
			} else {
				if _, err := io.WriteString(guest, want); err != nil {
					t.Fatal(err)
				}
				if err := guest.CloseWrite(); err != nil {
					t.Fatal(err)
				}
			}
			body, err := io.ReadAll(reader)
			if err != nil || string(body) != want {
				t.Fatalf("client response = %q, error = %v; want %q", body, err, want)
			}
			select {
			case err := <-done:
				if (cancelAfterEOF && !errors.Is(err, context.Canceled)) || (!cancelAfterEOF && err != nil) {
					t.Fatalf("relay error = %v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("CONNECT relay did not stop")
			}
		})
	}
}
