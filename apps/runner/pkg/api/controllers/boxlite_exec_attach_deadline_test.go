// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

package controllers

import (
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// delayedRefreshConn pauses the second liveness deadline update after the
// production cancellation check. Teardown's final deadline releases it only
// after being installed, so the stale refresh overwrites that deadline.
// Closing the transport also releases it, without relying on a read deadline.
type delayedRefreshConn struct {
	net.Conn
	initial     chan struct{}
	started     chan struct{}
	release     chan struct{}
	refreshed   chan struct{}
	releaseOnce sync.Once
	refreshes   int // only the reader installs liveness deadlines
}

func (c *delayedRefreshConn) resume() {
	c.releaseOnce.Do(func() { close(c.release) })
}

func (c *delayedRefreshConn) SetReadDeadline(deadline time.Time) error {
	if time.Until(deadline) > 10*time.Second {
		c.refreshes++
		if c.refreshes == 1 {
			err := c.Conn.SetReadDeadline(deadline)
			close(c.initial)
			return err
		}
		if c.refreshes == 2 {
			close(c.started)
			<-c.release
			err := c.Conn.SetReadDeadline(deadline)
			close(c.refreshed)
			return err
		}
	}
	err := c.Conn.SetReadDeadline(deadline)
	if !deadline.IsZero() && !deadline.After(time.Now()) {
		select {
		case <-c.started:
			c.resume()
			<-c.refreshed
		default: // HTTP hijacking can set a deadline before the attach loop.
		}
	}
	return err
}

func (c *delayedRefreshConn) Close() error {
	err := c.Conn.Close()
	c.resume()
	return err
}

type delayedRefreshListener struct {
	net.Listener
	accepted chan *delayedRefreshConn
}

func (l *delayedRefreshListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	wrapped := &delayedRefreshConn{
		Conn: conn, initial: make(chan struct{}), started: make(chan struct{}),
		release: make(chan struct{}), refreshed: make(chan struct{}),
	}
	l.accepted <- wrapped
	return wrapped, nil
}

func TestBoxliteExecAttach_DelayedPongRefreshCannotExtendClose(t *testing.T) {
	defer setPeerCloseWaitForTest(100 * time.Millisecond)()
	stub := newStubAttachExec()
	defer stub.stdoutW.Close()
	defer stub.stderrW.Close()
	finished := make(chan struct{})
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(finished)
		upgrader := websocket.Upgrader{}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		stub.connected.Store(true)
		runAttachLoop(r.Context(), conn, stub)
	}))
	listener := &delayedRefreshListener{Listener: srv.Listener, accepted: make(chan *delayedRefreshConn, 1)}
	srv.Listener = listener
	srv.Start()
	defer srv.Close()

	conn, _, err := dialAttach(t, srv, "exec-delayed-pong")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	serverConn := <-listener.accepted
	defer serverConn.Close()
	wait := func(ch <-chan struct{}, message string) {
		t.Helper()
		select {
		case <-ch:
		case <-time.After(2 * time.Second):
			t.Fatal(message)
		}
	}
	wait(serverConn.initial, "initial liveness deadline not installed")
	conn.SetCloseHandler(func(int, string) error { return nil })
	if err := conn.WriteControl(websocket.PongMessage, nil, time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	wait(serverConn.started, "Pong did not reach deadline refresh")
	close(stub.done)
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		_, _, err := conn.ReadMessage()
		if err == nil {
			continue
		}
		if !websocket.IsCloseError(err, websocket.CloseNormalClosure) {
			t.Fatalf("expected normal Close, got %v", err)
		}
		break
	}
	// The paused worker has resumed before the defect assertion: a failure
	// therefore measures the live socket, not a barrier held by this test.
	wait(serverConn.refreshed, "deadline refresh was not released by teardown")
	raw := conn.UnderlyingConn()
	_ = raw.SetReadDeadline(time.Now().Add(time.Second))
	_, err = raw.Read(make([]byte, 1))
	var netErr net.Error
	if err == nil || (errors.As(err, &netErr) && netErr.Timeout()) {
		t.Fatalf("delayed Pong refresh kept the transport open past the close bound: %v", err)
	}
	wait(finished, "attach workers did not finish after transport close")
	if stub.connected.Load() {
		t.Fatal("attach slot remained occupied after shutdown")
	}
}
