package server

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"io"
	"net"
	"net/http"
	"testing"
	"time"
)

type testDriver struct{}

func (testDriver) Open(string) (driver.Conn, error) { return testConn{}, nil }

type testConn struct{}

func (testConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (testConn) Close() error                        { return nil }
func (testConn) Begin() (driver.Tx, error)           { return nil, driver.ErrSkip }

func TestRunDrainsInflightRequest(t *testing.T) {
	sql.Register("shutdown-test", testDriver{})
	db, err := sql.Open("shutdown-test", "")
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	started, release := make(chan struct{}), make(chan struct{})
	s := &Server{config: Config{ShutdownTimeout: 5 * time.Second}, db: db, http: &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
		_, _ = w.Write([]byte("done"))
	})}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx, listener) }()
	response := make(chan error, 1)
	go func() {
		r, e := http.Get("http://" + listener.Addr().String())
		if e == nil {
			_, e = io.ReadAll(r.Body)
			r.Body.Close()
		}
		response <- e
	}()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("request did not start")
	}
	cancel()
	select {
	case err := <-done:
		t.Fatalf("stopped before request finished: %v", err)
	default:
	}
	close(release)
	select {
	case err := <-response:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("request did not finish")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown did not finish")
	}
}
