package boxlite

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// TestOneShotExecClosesStdinBeforeWaiting covers the stdin close on the
// one-shot path without a VM: the REST backend turns Execution.Stdin.Close
// into a `stdin_eof` control frame on the attach WebSocket. The fake server
// below answers with the exit frame only once it has seen that frame, so a
// helper that waits without closing stdin never gets an exit code — the same
// failure users see against a real box, minus the guest.
func TestOneShotExecClosesStdinBeforeWaiting(t *testing.T) {
	server := newStdinEOFAttachServer(t)
	defer server.Close()

	rt, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatalf("NewRest: %v", err)
	}
	defer func() {
		if err := rt.Close(); err != nil {
			t.Errorf("Close runtime: %v", err)
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	box, err := rt.Get(ctx, "box1")
	if err != nil {
		t.Fatalf("Get box: %v", err)
	}
	defer func() {
		if err := box.Close(); err != nil {
			t.Errorf("Close box: %v", err)
		}
	}()

	res, err := box.Exec(ctx, "cat")
	if err != nil {
		t.Fatalf("Box.Exec: %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("Box.Exec: exit code %d, want 0", res.ExitCode)
	}
	if got := server.stdinEOFs.Load(); got != 1 {
		t.Fatalf("server saw %d stdin_eof frames, want 1", got)
	}
}

// stdinEOFAttachServer is the smallest REST server that lets the SDK run an
// exec end to end: box metadata, exec creation, the attach WebSocket, and a
// 404 status probe so a pump that gives up fails fast instead of reconnecting.
type stdinEOFAttachServer struct {
	*httptest.Server
	stdinEOFs atomic.Int32
}

func newStdinEOFAttachServer(t *testing.T) *stdinEOFAttachServer {
	t.Helper()
	s := &stdinEOFAttachServer{}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/boxes/box1":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{
				"box_id":"box1","name":"service","status":"running",
				"created_at":"2026-10-16T00:00:00Z","updated_at":"2026-10-16T00:00:00Z",
				"pid":null,"image":"alpine:3.21","cpus":1,"memory_mib":256
			}`)
		case r.Method == http.MethodPost && r.URL.Path == "/v1/boxes/box1/exec":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"execution_id":"exec-1"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/boxes/box1/executions/exec-1/attach":
			s.serveAttach(t, w, r)
		default:
			// Includes the execution status probe: a 404 there makes the
			// client give up immediately rather than reconnect for minutes.
			http.NotFound(w, r)
		}
	}))
	return s
}

// serveAttach mirrors the runner's attach wire contract just far enough for
// this test: text frames in are control messages, and the exit frame goes
// out only after the client announced stdin EOF.
func (s *stdinEOFAttachServer) serveAttach(t *testing.T, w http.ResponseWriter, r *http.Request) {
	t.Helper()
	conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
	if err != nil {
		t.Errorf("upgrade: %v", err)
		return
	}
	defer conn.Close()

	for {
		kind, payload, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var ctl struct {
			Type string `json:"type"`
		}
		if kind != websocket.TextMessage || json.Unmarshal(payload, &ctl) != nil || ctl.Type != "stdin_eof" {
			continue
		}
		s.stdinEOFs.Add(1)
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"exit","exit_code":0}`))
		_ = conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
		return
	}
}
