//go:build boxlite_dev

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

package boxlite

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/gorilla/websocket"
)

// loopbackBoxAPI is a box API for one box, "box1", that a REST runtime
// resolves real *boxlite.Box handles against, so AttachMain and Start run end
// to end through the SDK with no VM behind them. Every WebSocket it accepts
// plays one session: "hi" on stdout, "oops" on stderr, then exit code 7.
type loopbackBoxAPI struct {
	*httptest.Server
	// refuse, when non-zero, is the status the main-session upgrade is refused
	// with. Fixed before the server starts, so handlers read it unlocked.
	refuse   int
	mu       sync.Mutex
	requests []string
}

func newLoopbackBoxAPI(t *testing.T, refuse int) *loopbackBoxAPI {
	t.Helper()
	api := &loopbackBoxAPI{refuse: refuse}
	api.Server = httptest.NewServer(http.HandlerFunc(api.serve))
	t.Cleanup(api.Close)
	return api
}

func (api *loopbackBoxAPI) serve(w http.ResponseWriter, r *http.Request) {
	request := r.Method + " " + r.URL.Path
	api.mu.Lock()
	api.requests = append(api.requests, request)
	api.mu.Unlock()

	switch request {
	case "GET /v1/boxes/box1":
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{
			"box_id":"box1","name":null,"status":"running",
			"created_at":"2026-07-14T00:00:00Z","updated_at":"2026-07-14T00:00:00Z",
			"pid":null,"image":"alpine:3.20","cpus":1,"memory_mib":256
		}`)
	case "GET /v1/boxes/box1/attach":
		if api.refuse != 0 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(api.refuse)
			_, _ = io.WriteString(w, `{"error":{"message":"main session already has an attached client","code":"already_exists"}}`)
			return
		}
		playLoopbackSession(w, r, http.Header{"X-Boxlite-Execution-Id": {"init-1"}})
	case "POST /v1/boxes/box1/exec":
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"execution_id":"exec-1"}`)
	case "GET /v1/boxes/box1/executions/exec-1/attach":
		playLoopbackSession(w, r, nil)
	default:
		http.NotFound(w, r)
	}
}

// received returns the requests the server saw, as "METHOD /path".
func (api *loopbackBoxAPI) received() []string {
	api.mu.Lock()
	defer api.mu.Unlock()
	return slices.Clone(api.requests)
}

// box resolves box1 through a REST runtime pointed at the server.
func (api *loopbackBoxAPI) box(ctx context.Context, t *testing.T) *boxlite.Box {
	t.Helper()
	rt, err := boxlite.NewRest(boxlite.BoxliteRestOptions{URL: api.URL})
	if err != nil {
		t.Fatalf("NewRest: %v", err)
	}
	t.Cleanup(func() { _ = rt.Close() })
	bx, err := rt.Get(ctx, "box1")
	if err != nil {
		t.Fatalf("Get box1: %v", err)
	}
	t.Cleanup(func() { _ = bx.Close() })
	return bx
}

var loopbackUpgrader = websocket.Upgrader{}

// playLoopbackSession sends the session and holds the connection until the
// client hangs up, which it does on the exit frame.
func playLoopbackSession(w http.ResponseWriter, r *http.Request, header http.Header) {
	conn, err := loopbackUpgrader.Upgrade(w, r, header)
	if err != nil {
		return
	}
	defer conn.Close()
	_ = conn.WriteMessage(websocket.BinaryMessage, []byte("\x01hi"))
	_ = conn.WriteMessage(websocket.BinaryMessage, []byte("\x02oops"))
	_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"exit","exit_code":7}`))
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}

// awaitExit waits for e's session to end, then returns everything each of its
// buses carried.
func awaitExit(t *testing.T, e *ManagedExec) (stdout, stderr string) {
	t.Helper()
	select {
	case <-e.Done:
	case <-time.After(15 * time.Second):
		t.Fatalf("execution %s did not finish", e.ID)
	}
	out, errOut, cancel := e.Subscribe(16)
	defer cancel()
	return drainSub(out), drainSub(errOut)
}

func drainSub(sub *streamSub) string {
	var sb strings.Builder
	for chunk := range sub.Chan() {
		sb.Write(chunk)
	}
	return sb.String()
}

// TestAttachMainOpensAndRegistersTheMainSession: the first attach joins init
// over the container-attach route and publishes it as a main session, with
// init's output on its buses and init's exit code recorded when it ends.
func TestAttachMainOpensAndRegistersTheMainSession(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	m := newQuietManager(t)
	api := newLoopbackBoxAPI(t, 0)
	bx := api.box(ctx, t)

	me, err := m.AttachMain(ctx, bx, "box1")
	if err != nil {
		t.Fatalf("AttachMain: %v", err)
	}
	if !me.Main || me.BoxID != "box1" || me.TTY {
		t.Errorf("got Main=%v BoxID=%q TTY=%v, want a non-TTY main session of box1", me.Main, me.BoxID, me.TTY)
	}
	if got, ok := m.Get(me.ID); !ok || got != me {
		t.Errorf("the main session must be registered under its id %q", me.ID)
	}

	stdout, stderr := awaitExit(t, me)
	if stdout != "hi" || stderr != "oops" {
		t.Errorf("got stdout %q and stderr %q, want %q and %q", stdout, stderr, "hi", "oops")
	}
	if me.ExitCode != 7 || me.Err != nil {
		t.Errorf("got exit %d (err %v), want init's 7", me.ExitCode, me.Err)
	}
	if got := api.received(); !slices.Contains(got, "GET /v1/boxes/box1/attach") {
		t.Errorf("AttachMain must use the container-attach route, got %v", got)
	}
}

// TestAttachMainReturnsARefusedAttachUnregistered: when the box refuses the
// attach the caller gets the SDK's typed error, and nothing is left in the
// registry for a later attach to find.
func TestAttachMainReturnsARefusedAttachUnregistered(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	m := newQuietManager(t)
	api := newLoopbackBoxAPI(t, http.StatusConflict)
	bx := api.box(ctx, t)

	me, err := m.AttachMain(ctx, bx, "box1")
	if err == nil {
		t.Fatalf("expected the refused attach to fail, got session %q", me.ID)
	}
	var sdkErr *boxlite.Error
	if !errors.As(err, &sdkErr) || !boxlite.IsAlreadyExists(err) {
		t.Errorf("expected the SDK's already-exists error, got %v", err)
	}
	if !strings.Contains(err.Error(), "failed to attach to box box1 main session") {
		t.Errorf("the error must name the operation and the box, got %v", err)
	}
	if found := m.findMain("box1"); found != nil {
		t.Errorf("a refused attach must not register a session, found %q", found.ID)
	}
}

// TestStartRegistersTheExecAndRecordsItsExit: Start shares the registry
// plumbing with AttachMain, so an exec must come out as an ordinary session
// with the same output and exit bookkeeping.
func TestStartRegistersTheExecAndRecordsItsExit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	m := newQuietManager(t)
	api := newLoopbackBoxAPI(t, 0)
	bx := api.box(ctx, t)

	id, err := m.Start(ctx, bx, "box1", StartOptions{Command: "sh", Args: []string{"-c", "true"}})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	e, ok := m.Get(id)
	if !ok {
		t.Fatalf("Start returned %q but registered nothing", id)
	}
	if e.Main || e.BoxID != "box1" {
		t.Errorf("got Main=%v BoxID=%q, want an exec of box1", e.Main, e.BoxID)
	}

	stdout, stderr := awaitExit(t, e)
	if stdout != "hi" || stderr != "oops" || e.ExitCode != 7 {
		t.Errorf("got stdout %q, stderr %q, exit %d; want %q, %q, 7", stdout, stderr, e.ExitCode, "hi", "oops")
	}
}
