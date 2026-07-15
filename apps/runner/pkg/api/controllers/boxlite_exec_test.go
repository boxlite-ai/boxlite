package controllers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/boxlite-ai/runner/pkg/boxlite"
	"github.com/gin-gonic/gin"
)

// signalCapturingExec is a minimal boxlite.ExecHandle stub that records
// every Signal call so tests can assert the controller plumbed the
// requested value through ExecManager rather than coercing it.
type signalCapturingExec struct {
	signals   []int
	killCount atomic.Int32
	killErr   error
	signalErr error
}

func (e *signalCapturingExec) Signal(_ context.Context, sig int) error {
	e.signals = append(e.signals, sig)
	return e.signalErr
}

func (e *signalCapturingExec) Kill(_ context.Context) error {
	e.killCount.Add(1)
	return e.killErr
}

func (e *signalCapturingExec) ResizeTTY(_ context.Context, _, _ int) error { return nil }
func (e *signalCapturingExec) Close() error                                { return nil }
func (e *signalCapturingExec) Wait(_ context.Context) (int, error)         { return 0, nil }

// withFreshExecManager swaps in an empty ExecManager for the duration of a
// test so handlers operate on a known registry. Returns a teardown that
// restores the original singleton.
func withFreshExecManager(t *testing.T) *boxlite.ExecManager {
	t.Helper()
	original := execManager
	fresh := boxlite.NewExecManager()
	execManager = fresh
	t.Cleanup(func() { execManager = original })
	return fresh
}

// runHandler routes the request through a real gin engine so middleware
// finalizers fire — notably, ctx.Status on its own doesn't flush
// WriteHeader, so a synthetic *gin.Context can't observe a 204. The router
// path mirrors production registration in server.go.
func runHandler(method, path, target string, body io.Reader, handler gin.HandlerFunc) *httptest.ResponseRecorder {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Handle(method, path, handler)
	req := httptest.NewRequest(method, target, body)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}

// seedManagedExec inserts a ManagedExec into the manager's registry with
// the supplied stub exec handle and returns the inserted struct so tests
// can flip its Done/ExitCode/Err fields to drive the running -> exited
// transition.
func seedManagedExec(mgr *boxlite.ExecManager, id string, handle boxlite.ExecHandle) *boxlite.ManagedExec {
	return seedManagedExecForBox(mgr, id, "box", handle)
}

func seedManagedExecForBox(mgr *boxlite.ExecManager, id, boxID string, handle boxlite.ExecHandle) *boxlite.ManagedExec {
	exec := &boxlite.ManagedExec{
		ID:    id,
		BoxID: boxID,
		Done:  make(chan struct{}),
	}
	exec.SetExecHandle(handle)
	mgr.Register(id, exec)
	return exec
}

// Phase 2.1: GET /executions/{id} reports running, then exited+exit_code
// after Done fires, with no other state surgery.
func TestBoxliteGetExecutionReturnsRunningThenExited(t *testing.T) {
	mgr := withFreshExecManager(t)
	exec := seedManagedExec(mgr, "exec-1", &signalCapturingExec{})

	w := runHandler(http.MethodGet,
		"/v1/boxes/:boxId/executions/:execId",
		"/v1/boxes/box/executions/exec-1",
		nil, BoxliteGetExecution)

	if w.Code != http.StatusOK {
		t.Fatalf("running: expected 200, got %d body=%s", w.Code, w.Body.String())
	}
	var info ExecutionInfoResponse
	if err := json.Unmarshal(w.Body.Bytes(), &info); err != nil {
		t.Fatalf("running: unmarshal failed: %v body=%s", err, w.Body.String())
	}
	if info.Status != "running" {
		t.Fatalf("running: expected status=running, got %+v", info)
	}
	if info.ExitCode != nil {
		t.Fatalf("running: expected exit_code omitted, got %+v", info)
	}

	exec.ExitCode = 42
	close(exec.Done)

	w2 := runHandler(http.MethodGet,
		"/v1/boxes/:boxId/executions/:execId",
		"/v1/boxes/box/executions/exec-1",
		nil, BoxliteGetExecution)

	if w2.Code != http.StatusOK {
		t.Fatalf("exited: expected 200, got %d body=%s", w2.Code, w2.Body.String())
	}
	var info2 ExecutionInfoResponse
	if err := json.Unmarshal(w2.Body.Bytes(), &info2); err != nil {
		t.Fatalf("exited: unmarshal failed: %v body=%s", err, w2.Body.String())
	}
	if info2.Status != "completed" {
		t.Fatalf("exited: expected status=completed, got %+v", info2)
	}
	if info2.ExitCode == nil || *info2.ExitCode != 42 {
		t.Fatalf("exited: expected exit_code=42, got %+v", info2)
	}
}

// Phase 2.1: missing exec id returns 404 instead of 200/empty body.
func TestBoxliteGetExecutionNotFound(t *testing.T) {
	withFreshExecManager(t)

	w := runHandler(http.MethodGet,
		"/v1/boxes/:boxId/executions/:execId",
		"/v1/boxes/box/executions/nope",
		nil, BoxliteGetExecution)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d body=%s", w.Code, w.Body.String())
	}
}

// Phase 2.3: SIGKILL (9) and STOP/CONT variants must be rejected with 400
// while a whitelisted signal (15) succeeds with 204.
func TestBoxliteExecSignalRejectsKILL(t *testing.T) {
	mgr := withFreshExecManager(t)
	stub := &signalCapturingExec{}
	seedManagedExec(mgr, "exec-2", stub)

	rejected := []int{9, 17, 18, 19, 23}
	for _, sig := range rejected {
		body := strings.NewReader(`{"signal":` + strconv.Itoa(sig) + `}`)
		w := runHandler(http.MethodPost,
			"/v1/boxes/:boxId/executions/:execId/signal",
			"/v1/boxes/box/executions/exec-2/signal",
			body, BoxliteExecSignal)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("signal %d: expected 400, got %d body=%s", sig, w.Code, w.Body.String())
		}
	}

	if len(stub.signals) != 0 {
		t.Fatalf("rejected signals must not reach the SDK; saw %v", stub.signals)
	}

	// Whitelisted signal goes through.
	w := runHandler(http.MethodPost,
		"/v1/boxes/:boxId/executions/:execId/signal",
		"/v1/boxes/box/executions/exec-2/signal",
		strings.NewReader(`{"signal":15}`), BoxliteExecSignal)
	if w.Code != http.StatusNoContent {
		t.Fatalf("SIGTERM: expected 204, got %d body=%s", w.Code, w.Body.String())
	}
	if len(stub.signals) != 1 || stub.signals[0] != 15 {
		t.Fatalf("SIGTERM: expected signal=15 forwarded, got %v", stub.signals)
	}
	if stub.killCount.Load() != 0 {
		t.Fatalf("SIGTERM must not be coerced to Kill(); kill count=%d", stub.killCount.Load())
	}
}

// Phase 2.3: the controller must bind the request body and pass the integer
// signal value through to ExecManager.Signal — the original bug was a no-op
// body-binding that fed every request to Kill().
func TestBoxliteExecSignalForwardsValueToExecManager(t *testing.T) {
	mgr := withFreshExecManager(t)
	stub := &signalCapturingExec{}
	seedManagedExec(mgr, "exec-3", stub)

	for _, sig := range []int{1, 2, 3, 6, 10, 12, 15, 28} {
		w := runHandler(http.MethodPost,
			"/v1/boxes/:boxId/executions/:execId/signal",
			"/v1/boxes/box/executions/exec-3/signal",
			strings.NewReader(`{"signal":`+strconv.Itoa(sig)+`}`),
			BoxliteExecSignal)
		if w.Code != http.StatusNoContent {
			t.Fatalf("signal %d: expected 204, got %d body=%s", sig, w.Code, w.Body.String())
		}
	}

	if len(stub.signals) != 8 {
		t.Fatalf("expected 8 signals plumbed through, got %d: %v", len(stub.signals), stub.signals)
	}
	expected := []int{1, 2, 3, 6, 10, 12, 15, 28}
	for i, sig := range expected {
		if stub.signals[i] != sig {
			t.Fatalf("at index %d: expected %d, got %d (full list: %v)", i, sig, stub.signals[i], stub.signals)
		}
	}
	if stub.killCount.Load() != 0 {
		t.Fatalf("Signal handler must never call Kill(); kill count=%d", stub.killCount.Load())
	}
}

// Finding 3 reproducer: cross-box access must be rejected. An execution
// seeded under box "box-A" must not be accessible via box "box-B".
func TestBoxliteExecCrossBoxAccess(t *testing.T) {
	mgr := withFreshExecManager(t)
	stub := &signalCapturingExec{}
	seedManagedExecForBox(mgr, "exec-xbox", "box-A", stub)

	// GET status via wrong box
	w := runHandler(http.MethodGet,
		"/v1/boxes/:boxId/executions/:execId",
		"/v1/boxes/box-B/executions/exec-xbox",
		nil, BoxliteGetExecution)
	if w.Code != http.StatusNotFound {
		t.Fatalf("cross-box GET: expected 404, got %d body=%s", w.Code, w.Body.String())
	}

	// Signal via wrong box
	w = runHandler(http.MethodPost,
		"/v1/boxes/:boxId/executions/:execId/signal",
		"/v1/boxes/box-B/executions/exec-xbox/signal",
		strings.NewReader(`{"signal":15}`), BoxliteExecSignal)
	if w.Code != http.StatusNotFound {
		t.Fatalf("cross-box Signal: expected 404, got %d body=%s", w.Code, w.Body.String())
	}

	// Kill via wrong box
	w = runHandler(http.MethodDelete,
		"/v1/boxes/:boxId/executions/:execId",
		"/v1/boxes/box-B/executions/exec-xbox",
		nil, BoxliteExecKill)
	if w.Code != http.StatusNotFound {
		t.Fatalf("cross-box Kill: expected 404, got %d body=%s", w.Code, w.Body.String())
	}

	// Resize via wrong box
	w = runHandler(http.MethodPost,
		"/v1/boxes/:boxId/executions/:execId/resize",
		"/v1/boxes/box-B/executions/exec-xbox/resize",
		strings.NewReader(`{"rows":24,"cols":80}`), BoxliteExecResize)
	if w.Code != http.StatusNotFound {
		t.Fatalf("cross-box Resize: expected 404, got %d body=%s", w.Code, w.Body.String())
	}

	// Correct box should succeed
	w = runHandler(http.MethodGet,
		"/v1/boxes/:boxId/executions/:execId",
		"/v1/boxes/box-A/executions/exec-xbox",
		nil, BoxliteGetExecution)
	if w.Code != http.StatusOK {
		t.Fatalf("same-box GET: expected 200, got %d body=%s", w.Code, w.Body.String())
	}
}

// Finding 5 reproducer: signal/resize during reaping must return 409.
func TestBoxliteExecSignalDuringReaping(t *testing.T) {
	mgr := withFreshExecManager(t)
	stub := &signalCapturingExec{}
	exec := seedManagedExec(mgr, "exec-reap", stub)

	// Simulate reaper starting kill
	exec.ReapingKill = true

	w := runHandler(http.MethodPost,
		"/v1/boxes/:boxId/executions/:execId/signal",
		"/v1/boxes/box/executions/exec-reap/signal",
		strings.NewReader(`{"signal":15}`), BoxliteExecSignal)
	if w.Code != http.StatusConflict {
		t.Fatalf("signal during reaping: expected 409, got %d body=%s", w.Code, w.Body.String())
	}
}

// Finding 10 reproducer: closed exec signal returns 409, not 404.
func TestBoxliteExecSignalClosedReturns409(t *testing.T) {
	mgr := withFreshExecManager(t)
	stub := &signalCapturingExec{}
	exec := seedManagedExec(mgr, "exec-closed", stub)
	close(exec.Done)

	w := runHandler(http.MethodPost,
		"/v1/boxes/:boxId/executions/:execId/signal",
		"/v1/boxes/box/executions/exec-closed/signal",
		strings.NewReader(`{"signal":15}`), BoxliteExecSignal)
	// Should be 409 (closed/conflict), not 404
	if w.Code != http.StatusConflict {
		t.Fatalf("signal on closed exec: expected 409, got %d body=%s", w.Code, w.Body.String())
	}
}
