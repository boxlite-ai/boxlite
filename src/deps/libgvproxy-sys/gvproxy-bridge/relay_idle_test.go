package main

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

// io.Pipe preserves independent EOFs and lets synctest advance the real relay's
// ten-minute timer without using wall-clock sleeps or socket deadlines.
type idleTestConn struct {
	reader *io.PipeReader
	writer *io.PipeWriter
	closed chan struct{}
	once   sync.Once
}

func idleTestPair() (*idleTestConn, *idleTestConn) {
	ar, bw := io.Pipe()
	br, aw := io.Pipe()
	return &idleTestConn{reader: ar, writer: aw, closed: make(chan struct{})},
		&idleTestConn{reader: br, writer: bw, closed: make(chan struct{})}
}

func (c *idleTestConn) Read(p []byte) (int, error)  { return c.reader.Read(p) }
func (c *idleTestConn) Write(p []byte) (int, error) { return c.writer.Write(p) }
func (c *idleTestConn) CloseWrite() error           { return c.writer.Close() }
func (c *idleTestConn) Close() error {
	c.once.Do(func() {
		c.reader.Close()
		c.writer.Close()
		close(c.closed)
	})
	return nil
}
func (c *idleTestConn) LocalAddr() net.Addr              { return &net.TCPAddr{} }
func (c *idleTestConn) RemoteAddr() net.Addr             { return &net.TCPAddr{} }
func (c *idleTestConn) SetDeadline(time.Time) error      { return errors.ErrUnsupported }
func (c *idleTestConn) SetReadDeadline(time.Time) error  { return errors.ErrUnsupported }
func (c *idleTestConn) SetWriteDeadline(time.Time) error { return errors.ErrUnsupported }

type blockedShutdownConn struct{ *idleTestConn }

func (c *blockedShutdownConn) CloseWrite() error { <-c.closed; return net.ErrClosed }

func TestRelayHalfCloseIdle(t *testing.T) {
	for _, relayName := range []string{"control", "target"} {
		t.Run(relayName, func(t *testing.T) {
			relay := func(ctx context.Context, left, right net.Conn) error {
				if relayName == "control" {
					relayTunnel(ctx, left, right, left)
				} else {
					(&relayTarget{ctx: ctx, dial: func(context.Context, string) (net.Conn, error) { return right, nil }}).HandleConn(left)
				}
				return nil
			}
			for _, scenario := range []string{"left_idle", "right_idle", "progress_renews", "fully_open", "blocked_write", "blocked_close_write"} {
				t.Run(scenario, func(t *testing.T) {
					synctest.Test(t, func(t *testing.T) {
						client, left := idleTestPair()
						right, guest := idleTestPair()
						ctx, cancel := context.WithCancel(context.Background())
						done := make(chan error, 1)
						var destination net.Conn = right
						if scenario == "blocked_close_write" {
							destination = &blockedShutdownConn{right}
						}
						go func() { done <- relay(ctx, left, destination) }()
						defer func() {
							cancel()
							for _, c := range []*idleTestConn{client, left, right, guest} {
								c.Close()
							}
							synctest.Wait()
						}()
						assertRunning := func() {
							t.Helper()
							synctest.Wait()
							select {
							case err := <-done:
								t.Fatalf("relay stopped before idle deadline: %v", err)
							default:
							}
						}
						if scenario == "fully_open" {
							time.Sleep(11 * time.Minute)
							assertRunning()
							return
						}
						sender, receiver := client, guest
						if scenario == "right_idle" {
							sender, receiver = guest, client
						}
						sender.CloseWrite()
						if scenario != "blocked_close_write" {
							if data, err := io.ReadAll(receiver); err != nil || len(data) != 0 {
								t.Fatalf("half-close propagation: data=%q error=%v", data, err)
							}
						}
						assertRunning()
						if scenario == "progress_renews" {
							for i := 0; i < 3; i++ {
								time.Sleep(9 * time.Minute)
								assertRunning()
								written := make(chan error, 1)
								go func() { _, err := receiver.Write([]byte("response")); written <- err }()
								payload := make([]byte, len("response"))
								if _, err := io.ReadFull(sender, payload); err != nil || string(payload) != "response" {
									t.Fatalf("forwarded response = %q, error = %v", payload, err)
								}
								if err := <-written; err != nil {
									t.Fatal(err)
								}
								assertRunning()
							}
						}
						if scenario == "blocked_write" {
							go receiver.Write(make([]byte, 65536)) // receiver stays unread at the far end
							synctest.Wait()
						}
						time.Sleep(10*time.Minute - time.Nanosecond)
						assertRunning()
						time.Sleep(time.Nanosecond)
						synctest.Wait()
						select {
						case err := <-done:
							if err != nil {
								t.Fatalf("idle cleanup error = %v", err)
							}
						default:
							t.Fatal("relay still running after ten minutes without payload")
						}
						for _, c := range []*idleTestConn{left, right} {
							select {
							case <-c.closed:
							default:
								t.Error("relay left a connection open")
							}
						}
					})
				})
			}
		})
	}
}
