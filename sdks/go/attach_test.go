package boxlite

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// sessionServer is a box API for one box, "box1", over loopback. Every
// WebSocket it accepts plays the same session — "hi" on stdout, "oops" on
// stderr, then exit code 7 — so a test can tell whether what the session
// produced reached the caller. The upgrade is completed by hand because the
// SDK has no WebSocket dependency to borrow a server from.
type sessionServer struct {
	*httptest.Server
	// refuse, when non-zero, is the status the main-session upgrade is refused
	// with; hold keeps the main session running past its first output. Both
	// are fixed before the server starts, so handlers read them unlocked.
	refuse   int
	hold     bool
	mu       sync.Mutex
	requests []string
}

func newSessionServer(t *testing.T, refuse int) *sessionServer {
	t.Helper()
	return startSessionServer(t, &sessionServer{refuse: refuse})
}

// startSessionServer serves s until the test ends.
func startSessionServer(t *testing.T, s *sessionServer) *sessionServer {
	t.Helper()
	s.Server = httptest.NewServer(http.HandlerFunc(s.serve))
	t.Cleanup(s.Close)
	return s
}

func (s *sessionServer) serve(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.requests = append(s.requests, r.Method+" "+r.URL.RequestURI())
	s.mu.Unlock()

	switch r.Method + " " + r.URL.Path {
	case "GET /v1/boxes/box1":
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{
			"box_id":"box1","name":null,"status":"running",
			"created_at":"2026-07-14T00:00:00Z","updated_at":"2026-07-14T00:00:00Z",
			"pid":null,"image":"alpine:3.20","cpus":1,"memory_mib":256
		}`)
	case "GET /v1/boxes/box1/attach":
		if s.refuse != 0 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(s.refuse)
			_, _ = io.WriteString(w, `{"error":{"message":"main session already has an attached client","code":"already_exists"}}`)
			return
		}
		if s.hold {
			playHeldSession(w, r, "X-Boxlite-Execution-Id: init-1\r\n")
			return
		}
		playSession(w, r, "X-Boxlite-Execution-Id: init-1\r\n")
	case "POST /v1/boxes/box1/exec":
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"execution_id":"exec-1"}`)
	case "GET /v1/boxes/box1/executions/exec-1/attach":
		playSession(w, r, "")
	default:
		http.NotFound(w, r)
	}
}

// received returns the requests the server saw, as "METHOD /path?query".
func (s *sessionServer) received() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.requests)
}

// box resolves box1 through a REST runtime pointed at the server.
func (s *sessionServer) box(ctx context.Context, t *testing.T) *Box {
	t.Helper()
	rt, err := NewRest(BoxliteRestOptions{URL: s.URL})
	if err != nil {
		t.Fatalf("NewRest: %v", err)
	}
	t.Cleanup(func() { _ = rt.Close() })
	box, err := rt.Get(ctx, "box1")
	if err != nil {
		t.Fatalf("Get box1: %v", err)
	}
	t.Cleanup(func() { _ = box.Close() })
	return box
}

// upgrade completes the WebSocket handshake by hand, extraHeaders raw header
// lines on the 101, and returns the hijacked connection, or ok false once it
// has answered with an error instead.
func upgrade(w http.ResponseWriter, r *http.Request, extraHeaders string) (conn net.Conn, rw *bufio.ReadWriter, ok bool) {
	accept := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	conn, rw, err := w.(http.Hijacker).Hijack()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return nil, nil, false
	}
	_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + base64.StdEncoding.EncodeToString(accept[:]) + "\r\n" + extraHeaders + "\r\n")
	return conn, rw, true
}

// playHeldSession plays a session that is still running when the client gets
// it: "hi", then the exit only once the client hangs up or two seconds pass.
// The bound keeps a client that waits for the exit from hanging the test.
func playHeldSession(w http.ResponseWriter, r *http.Request, extraHeaders string) {
	conn, rw, ok := upgrade(w, r, extraHeaders)
	if !ok {
		return
	}
	defer conn.Close()

	writeServerFrame(rw, 0x2, []byte("\x01hi"))
	if rw.Flush() != nil {
		return
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _ = io.Copy(io.Discard, rw)
	writeServerFrame(rw, 0x1, []byte(`{"type":"exit","exit_code":7}`))
	_ = rw.Flush()
}

// playSession upgrades the request, sends the session, and holds the
// connection until the client hangs up, which it does on the exit frame.
// extraHeaders is raw header lines added to the 101.
func playSession(w http.ResponseWriter, r *http.Request, extraHeaders string) {
	conn, rw, ok := upgrade(w, r, extraHeaders)
	if !ok {
		return
	}
	defer conn.Close()

	writeServerFrame(rw, 0x2, []byte("\x01hi"))
	writeServerFrame(rw, 0x2, []byte("\x02oops"))
	writeServerFrame(rw, 0x1, []byte(`{"type":"exit","exit_code":7}`))
	if rw.Flush() != nil {
		return
	}
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	_, _ = io.Copy(io.Discard, rw)
}

// writeServerFrame writes one final, unmasked frame; every payload here fits
// the 7-bit length.
func writeServerFrame(w *bufio.ReadWriter, opcode byte, payload []byte) {
	_, _ = w.Write(append([]byte{0x80 | opcode, byte(len(payload))}, payload...))
}

// lockedBuffer is a bytes.Buffer an output callback can write while the test
// reads it.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// TestAttachDeliversInitOutputAndExitCode: attaching joins init over the
// container-attach route, every sink in AttachOptions receives what init
// wrote, and Wait returns init's exit code.
func TestAttachDeliversInitOutputAndExitCode(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	server := newSessionServer(t, 0)
	box := server.box(ctx, t)

	var stdout, stderr, onStdout, onStderr lockedBuffer
	execution, err := box.Attach(ctx, &AttachOptions{
		Stdout:   &stdout,
		Stderr:   &stderr,
		OnStdout: func(p []byte) { _, _ = onStdout.Write(p) },
		OnStderr: func(p []byte) { _, _ = onStderr.Write(p) },
	})
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	defer execution.Close()

	code, err := execution.Wait(ctx)
	if err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if code != 7 {
		t.Errorf("exit code: got %d, want init's 7", code)
	}
	sinks := []struct {
		name string
		got  *lockedBuffer
		want string
	}{
		{"Stdout", &stdout, "hi"},
		{"OnStdout", &onStdout, "hi"},
		{"Stderr", &stderr, "oops"},
		{"OnStderr", &onStderr, "oops"},
	}
	for _, sink := range sinks {
		if got := sink.got.String(); got != sink.want {
			t.Errorf("%s: got %q, want %q", sink.name, got, sink.want)
		}
	}
	if got := server.received(); !slices.Contains(got, "GET /v1/boxes/box1/attach") {
		t.Errorf("attach must use the container-attach route, got %v", got)
	}
}

// TestAttachReturnsTheRefusal: a refused attach fails at the call, typed so
// the caller can tell that another client holds the session.
func TestAttachReturnsTheRefusal(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	server := newSessionServer(t, http.StatusConflict)
	box := server.box(ctx, t)

	execution, err := box.Attach(ctx, nil)
	if err == nil {
		execution.Close()
		t.Fatal("expected the refused attach to fail")
	}
	if !IsAlreadyExists(err) {
		t.Fatalf("expected an already-exists error, got %v", err)
	}
}

// TestCloseDetachesWithoutKillingTheSession: an attach joins a session the box
// owns, so closing the handle while that session still runs must let go of it
// rather than end it — no kill reaches the server.
func TestCloseDetachesWithoutKillingTheSession(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	server := startSessionServer(t, &sessionServer{hold: true})
	box := server.box(ctx, t)

	execution, err := box.Attach(ctx, nil)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	if err := execution.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	for _, request := range server.received() {
		if strings.HasPrefix(request, "DELETE ") {
			t.Fatalf("closing an attach must not kill the session, got %v", server.received())
		}
	}
}

// TestAttachRejoinsAnExecByIDReadOnly: an ExecutionID rejoins that exec over
// the exec route instead of the main session, and ReadOnly asks the server to
// refuse stdin rather than trusting the client to leave it alone.
func TestAttachRejoinsAnExecByIDReadOnly(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	server := newSessionServer(t, 0)
	box := server.box(ctx, t)

	var stdout lockedBuffer
	execution, err := box.Attach(ctx, &AttachOptions{ExecutionID: "exec-1", ReadOnly: true, Stdout: &stdout})
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	defer execution.Close()

	code, err := execution.Wait(ctx)
	if err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if code != 7 || stdout.String() != "hi" {
		t.Errorf("got exit %d and stdout %q, want 7 and %q", code, stdout.String(), "hi")
	}
	if got := server.received(); !slices.Contains(got, "GET /v1/boxes/box1/executions/exec-1/attach?stdin=0") {
		t.Errorf("expected a read-only attach on the exec route, got %v", got)
	}
}

// TestStartExecutionDeliversOutputAndExitCode: an exec is wired by the same
// code as an attach, so its output and exit code must reach the caller too.
func TestStartExecutionDeliversOutputAndExitCode(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	server := newSessionServer(t, 0)
	box := server.box(ctx, t)

	var stdout lockedBuffer
	execution, err := box.StartExecution(ctx, "sh", []string{"-c", "true"}, &ExecutionOptions{Stdout: &stdout})
	if err != nil {
		t.Fatalf("StartExecution: %v", err)
	}
	defer execution.Close()

	code, err := execution.Wait(ctx)
	if err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if code != 7 || stdout.String() != "hi" {
		t.Errorf("got exit %d and stdout %q, want 7 and %q", code, stdout.String(), "hi")
	}
}
