package server

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type drainListener struct {
	net.Listener
	closed chan struct{}
	fail   <-chan struct{}
	err    error
	first  bool
	once   sync.Once
}

func (l *drainListener) Accept() (net.Conn, error) {
	if l.fail == nil || !l.first {
		l.first = true
		return l.Listener.Accept()
	}
	select {
	case <-l.fail:
		return nil, l.err
	case <-l.closed:
		return nil, net.ErrClosed
	}
}

func (l *drainListener) Close() error {
	err := l.Listener.Close()
	l.once.Do(func() { close(l.closed) })
	return err
}

func TestRunDrainsInflightRequest(t *testing.T) {
	t.Run("cancellation", func(t *testing.T) { testRunDrainsInflightRequest(t, nil) })
	t.Run("accept failure", func(t *testing.T) {
		testRunDrainsInflightRequest(t, errors.New("permanent accept failure"))
	})
}

func testRunDrainsInflightRequest(t *testing.T, acceptErr error) {
	t.Helper()
	db, err := pgxpool.New(context.Background(), "postgres://localhost/test")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	tcp, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer tcp.Close()
	listener := &drainListener{Listener: tcp, closed: make(chan struct{}), err: acceptErr}
	fail := make(chan struct{})
	if acceptErr != nil {
		listener.fail = fail
	}
	started, release := make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	s := &Server{config: Config{ShutdownTimeout: 5 * time.Second}, db: db, http: &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
		_, _ = w.Write([]byte("done"))
	})}}
	shuttingDown := make(chan struct{})
	s.http.RegisterOnShutdown(func() { close(shuttingDown) })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx, listener) }()
	response := make(chan error, 1)
	go func() {
		r, e := (&http.Client{Timeout: 8 * time.Second}).Get("http://" + listener.Addr().String())
		if e == nil {
			var body []byte
			body, e = io.ReadAll(r.Body)
			r.Body.Close()
			if e == nil && (r.StatusCode != http.StatusOK || string(body) != "done") {
				e = errors.New("client did not receive the complete response")
			}
		}
		response <- e
	}()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("request did not start")
	}
	if acceptErr == nil {
		cancel()
	} else {
		close(fail)
	}
	select {
	case <-listener.closed:
	case <-time.After(3 * time.Second):
		t.Fatal("shutdown did not close the listener")
	}
	select {
	case <-shuttingDown:
	case err := <-done:
		t.Fatalf("Run returned without draining the active request: %v", err)
	case <-time.After(3 * time.Second):
		t.Fatal("HTTP shutdown did not begin")
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
		if !errors.Is(err, acceptErr) {
			t.Fatalf("Run returned %v, want %v", err, acceptErr)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown did not finish")
	}
}

func TestRunBoundsDatabaseCleanup(t *testing.T) {
	dsn := os.Getenv("SECRET_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("SECRET_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	db, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal("create test pool")
	}
	defer db.Close()
	conn, err := db.Acquire(ctx)
	if err != nil {
		t.Fatal("acquire connection for shutdown test")
	}
	defer conn.Release()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	s := &Server{config: Config{ShutdownTimeout: 100 * time.Millisecond}, db: db, http: &http.Server{Handler: http.NotFoundHandler()}}
	runCtx, stop := context.WithCancel(ctx)
	defer stop()
	done := make(chan error, 1)
	go func() {
		err := s.Run(runCtx, listener)
		_ = s.Close()
		done <- err
	}()
	stop()
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("Run returned %v, want shutdown deadline", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Run and deferred Close blocked while the database connection was still checked out")
	}
}

func TestRunReturnsListenerError(t *testing.T) {
	db, err := pgxpool.New(context.Background(), "postgres://localhost/test")
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	s := &Server{db: db, http: &http.Server{Handler: http.NotFoundHandler()}}
	if err := s.Run(context.Background(), listener); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("Run with closed listener = %v, want closed listener error", err)
	}
}

func TestRunForcesCloseAfterShutdownTimeout(t *testing.T) {
	db, err := pgxpool.New(context.Background(), "postgres://localhost/test")
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	started, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	s := &Server{config: Config{ShutdownTimeout: 100 * time.Millisecond}, db: db, http: &http.Server{Handler: http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		close(started)
		defer close(finished)
		<-release
	})}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx, listener) }()
	requestDone := make(chan error, 1)
	go func() {
		response, err := (&http.Client{Timeout: 3 * time.Second}).Get("http://" + listener.Addr().String())
		if response != nil {
			response.Body.Close()
		}
		requestDone <- err
	}()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		close(release)
		t.Fatal("request did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			close(release)
			t.Fatalf("Run = %v, want shutdown timeout", err)
		}
	case <-time.After(3 * time.Second):
		close(release)
		t.Fatal("Run did not return after shutdown timeout")
	}
	select {
	case err := <-requestDone:
		if err == nil {
			close(release)
			t.Fatal("request succeeded despite forced close")
		}
	case <-time.After(3 * time.Second):
		close(release)
		t.Fatal("forced close did not interrupt request")
	}
	close(release)
	select {
	case <-finished:
	case <-time.After(3 * time.Second):
		t.Fatal("handler did not finish")
	}
}
