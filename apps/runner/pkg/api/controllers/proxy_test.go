// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package controllers

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	sdkboxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

func TestIsTerminalToolboxPath(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{"", true},
		{"/", true},
		{"proxy/22222", true},
		{"/proxy/22222", true},
		{"/proxy/22222/", true},
		{"/proxy/22222/vnc.html", true},
		{"/proxy/6080/", false},
		{"/computeruse/status", false},
		{"/process/execute", false},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			if got := isTerminalToolboxPath(tt.path); got != tt.want {
				t.Fatalf("isTerminalToolboxPath(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

// Drives handleWebSocketTerminal itself with a start that fails, which is the
// branch that owes its peer a closing handshake. Reproducing the branch in the
// test instead would leave the call site unverified — the thing the seam exists
// to make reachable.
func newTerminalServer(t *testing.T, startErr error) (*httptest.Server, <-chan struct{}) {
	t.Helper()
	prev := startTerminalExecution
	startTerminalExecution = func(context.Context, *runner.Runner, string, string, []string, io.Writer) (*sdkboxlite.Execution, error) {
		return nil, startErr
	}
	t.Cleanup(func() { startTerminalExecution = prev })

	returned := make(chan struct{})
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/terminal", func(c *gin.Context) {
		handleWebSocketTerminal(c, &runner.Runner{}, "box-1", slog.New(slog.NewTextHandler(io.Discard, nil)))
		close(returned)
	})
	return httptest.NewServer(r), returned
}

func dialTerminal(t *testing.T, srv *httptest.Server) *websocket.Conn {
	t.Helper()
	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = 5 * time.Second
	conn, _, err := dialer.Dial(strings.Replace(srv.URL, "http://", "ws://", 1)+"/terminal", nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	// Say nothing back: gorilla answers a Close with its own, which would
	// complete the handshake and hide what the server does unprompted.
	conn.SetCloseHandler(func(int, string) error { return nil })
	return conn
}

func readTerminalFailureClose(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := conn.ReadMessage(); !websocket.IsCloseError(err, websocket.CloseInternalServerErr) {
		t.Fatalf("expected the failure Close, got %v", err)
	}
}

// The reason that Close carries is worth nothing if the connection dies with
// it: whatever is still relaying the 101 reads that as a failed upgrade and
// hands the client a generic 502 instead.
func TestHandleWebSocketTerminal_FailedStartHoldsTheConnection(t *testing.T) {
	restore := setPeerCloseWaitForTest(2 * time.Second)
	defer restore()

	srv, _ := newTerminalServer(t, errors.New("no such box"))
	defer srv.Close()
	conn := dialTerminal(t, srv)
	defer conn.Close()
	readTerminalFailureClose(t, conn)

	raw := conn.UnderlyingConn()
	_ = raw.SetReadDeadline(time.Now().Add(400 * time.Millisecond))
	_, err := raw.Read(make([]byte, 1))
	var netErr net.Error
	if !errors.As(err, &netErr) || !netErr.Timeout() {
		t.Fatalf("connection was dropped without waiting for the peer: %v", err)
	}
}

// And the handler has to return on its own, however the peer behaves. Nothing
// on this path pushes the read deadline out, so the bound is absolute.
func TestHandleWebSocketTerminal_FailedStartEndsAtTheBound(t *testing.T) {
	for _, peer := range []struct {
		name string
		talk bool
	}{{"silent", false}, {"talking", true}} {
		t.Run(peer.name, func(t *testing.T) {
			restore := setPeerCloseWaitForTest(300 * time.Millisecond)
			defer restore()

			srv, returned := newTerminalServer(t, errors.New("no such box"))
			defer srv.Close()
			conn := dialTerminal(t, srv)
			defer conn.Close()
			readTerminalFailureClose(t, conn)

			if peer.talk {
				stop := make(chan struct{})
				defer close(stop)
				go func() {
					for {
						select {
						case <-stop:
							return
						default:
						}
						if err := conn.WriteMessage(websocket.BinaryMessage, []byte("x")); err != nil {
							return
						}
						time.Sleep(time.Millisecond)
					}
				}()
			}

			select {
			case <-returned:
			case <-time.After(2 * time.Second):
				t.Fatal("the handler outlived its bound")
			}
		})
	}
}

// A peer that answers ends it at once rather than paying the bound.
func TestHandleWebSocketTerminal_PeerAnswerEndsItPromptly(t *testing.T) {
	restore := setPeerCloseWaitForTest(5 * time.Second)
	defer restore()

	srv, returned := newTerminalServer(t, errors.New("no such box"))
	defer srv.Close()
	conn := dialTerminal(t, srv)
	defer conn.Close()
	readTerminalFailureClose(t, conn)

	if err := conn.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
		time.Now().Add(time.Second),
	); err != nil {
		t.Fatalf("answer the close: %v", err)
	}

	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("an answered close still paid the full bound")
	}
}
