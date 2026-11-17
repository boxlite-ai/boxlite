//go:build boxlite_dev && boxlite_agent_test

package boxlite

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func testAgents(t *testing.T, manual bool) (*Runtime, *Agents) {
	t.Helper()
	r, a, err := newTestAgentNamespace(t.TempDir(), manual)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Close(); runtime.KeepAlive(a) })
	return r, a
}
func testCreateAgent(t *testing.T, a *Agents) *Agent {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	agent, err := a.Create(ctx, "test", AgentCreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { runtime.KeepAlive(agent) })
	return agent
}
func agentHandleCount(r *Runtime) int {
	r.agentMu.RLock()
	defer r.agentMu.RUnlock()
	return len(r.agentHandles)
}
func agentTokenCount() int {
	n := 0
	activeHandles.Range(func(_, _ any) bool { n++; return true })
	return n
}
func receiveAgent[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(5 * time.Second):
		t.Fatal("agent operation did not finish")
		var zero T
		return zero
	}
}

func TestAgentCallsAndGettersReachCore(t *testing.T) {
	_, a := testAgents(t, false)
	agent := testCreateAgent(t, a)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	adopted, err := a.Get(ctx, "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.KeepAlive(adopted)
	state, err := adopted.State()
	if err != nil || state.ID != "agent-1" || state.Status != AgentReady || len(state.Requests) != 0 {
		t.Fatalf("state=%+v err=%v", state, err)
	}
	config, err := agent.Config()
	if err != nil || config.Model != "" || config.Tools == nil || config.MCP == nil || config.Permissions != nil {
		t.Fatalf("config=%+v err=%v", config, err)
	}
	caps, err := agent.Capabilities()
	if err != nil || !reflect.DeepEqual(caps.Operations, []string{"agent.send"}) || caps.MaxQueuedTurns != nil {
		t.Fatalf("capabilities=%+v err=%v", caps, err)
	}
	for _, data := range []string{"false", "0", "[]", `{"nested":null}`} {
		turn, err := agent.Send(ctx, "echo", AgentSendOptions{Mode: AgentSendReject, Data: json.RawMessage(data)})
		if err != nil {
			t.Fatal(err)
		}
		state, err := turn.State()
		if err != nil || state.ID != "turn-1" || state.AgentID != "agent-1" || state.Status != AgentTurnCompleted || state.Result.Text != "echo" || string(state.Result.Data) != data {
			t.Fatalf("turn state=%+v err=%v", state, err)
		}
		loaded, err := agent.GetTurn(ctx, state.ID)
		if err != nil {
			t.Fatal(err)
		}
		zero := time.Duration(0)
		result, err := loaded.Wait(ctx, AgentWaitOptions{Timeout: &zero})
		if err != nil || result.Status != AgentTurnCompleted || result.Text != "echo" || string(result.Data) != data {
			t.Fatalf("result=%+v err=%v", result, err)
		}
		runtime.KeepAlive(turn)
		runtime.KeepAlive(loaded)
	}
	requests, err := agent.Requests(ctx)
	if err != nil || len(requests) != 1 || requests[0].ID != "request-1" {
		t.Fatalf("requests=%+v err=%v", requests, err)
	}
	question, ok := requests[0].Kind.(AgentQuestion)
	if !ok || question.Text != "continue?" {
		t.Fatalf("question=%+v", requests[0].Kind)
	}
	answer, err := agent.Respond(ctx, requests[0].ID, &AgentAnswer{Text: "yes", Data: json.RawMessage(`{"approved":false,"n":0,"items":[],"child":null}`)}, AgentControlOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.KeepAlive(answer)
	result, err := answer.Wait(ctx, AgentWaitOptions{})
	if err != nil || result.Text != "yes" || string(result.Data) != `{"approved":false,"child":null,"items":[],"n":0}` {
		t.Fatalf("answer=%+v err=%v", result, err)
	}
	denied, err := agent.Respond(ctx, "request-1", AgentPermissionResponse{Approved: false}, AgentControlOptions{})
	checkAgentError(t, denied, err, ErrInvalidArgument)
}

func TestAgentCoreErrorsAreCopied(t *testing.T) {
	_, a := testAgents(t, false)
	agent := testCreateAgent(t, a)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	missing, err := agent.GetTurn(ctx, "unknown")
	checkAgentError(t, missing, err, ErrNotFound)
	if !strings.Contains(err.Error(), "unknown") {
		t.Fatal(err)
	}
	savedError := err
	turn, err := agent.Send(ctx, "work", AgentSendOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.KeepAlive(turn)
	// Repeated failures force borrowed native messages to be allocated and freed.
	for range 3 {
		checkAgentError(t, nil, agent.Close(ctx, AgentControlOptions{}), ErrUnsupported)
		receipt, err := turn.Steer(ctx, "next", AgentControlOptions{})
		checkAgentError(t, receipt, err, ErrUnsupported)
		checkAgentError(t, nil, turn.Interrupt(ctx, AgentControlOptions{}), ErrUnsupported)
	}
	if !strings.Contains(savedError.Error(), "unknown") {
		t.Fatal("borrowed error changed after subsequent callbacks", savedError)
	}
	state, err := agent.State()
	if err != nil || state.ID != "agent-1" {
		t.Fatalf("semantic close invalidated handle: %v", err)
	}
}

func TestAgentArgumentsFailBeforeDispatch(t *testing.T) {
	r, a := testAgents(t, false)
	agent := testCreateAgent(t, a)
	ctx := context.Background()
	before := agentTokenCount()
	handles := agentHandleCount(r)
	tests := []struct {
		name string
		call func() error
	}{
		{"name NUL", func() error { _, e := a.Create(ctx, "test\x00suffix", AgentCreateOptions{}); return e }},
		{"cwd UTF8", func() error { _, e := a.Create(ctx, "test", AgentCreateOptions{Cwd: string([]byte{255})}); return e }},
		{"config JSON", func() error {
			_, e := a.Create(ctx, "test", AgentCreateOptions{Config: AgentConfig{Permissions: json.RawMessage("{")}})
			return e
		}},
		{"ID NUL", func() error { _, e := a.Get(ctx, "agent\x00"); return e }},
		{"mode", func() error { _, e := agent.Send(ctx, "work", AgentSendOptions{Mode: "invalid"}); return e }},
		{"data JSON", func() error { _, e := agent.Send(ctx, "work", AgentSendOptions{Data: json.RawMessage("{")}); return e }},
		{"text UTF8", func() error { _, e := agent.Send(ctx, string([]byte{255}), AgentSendOptions{}); return e }},
		{"key NUL", func() error { return agent.Close(ctx, AgentControlOptions{IdempotencyKey: "k\x00"}) }},
		{"answer JSON", func() error {
			_, e := agent.Respond(ctx, "request-1", AgentAnswer{Data: json.RawMessage("{")}, AgentControlOptions{})
			return e
		}},
		{"nil response", func() error {
			_, e := agent.Respond(ctx, "request-1", (*AgentAnswer)(nil), AgentControlOptions{})
			return e
		}},
		{"nil context", func() error { _, e := agent.Requests(nil); return e }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			checkAgentError(t, nil, tt.call(), ErrInvalidArgument)
			if agentTokenCount() != before || agentHandleCount(r) != handles {
				t.Fatal("invalid input submitted native work")
			}
		})
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	empty := (&Box{}).Agents()
	result, err := empty.Create(canceled, "test", AgentCreateOptions{})
	if result != nil || !errors.Is(err, context.Canceled) || empty.native != nil {
		t.Fatalf("canceled namespace: %v %v", result, err)
	}
}

func TestAgentCancelBeforeDispatchFreesLateHandle(t *testing.T) {
	r, a := testAgents(t, true)
	before, _ := testAgentFreeCounts()
	tokens := agentTokenCount()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		value, err := a.Create(ctx, "test", AgentCreateOptions{})
		if value != nil {
			err = errors.New("canceled create returned a handle")
		}
		done <- err
	}()
	if !testAgentWaitPending(r) {
		t.Fatal("no completion posted")
	}
	cancel()
	if err := receiveAgent(t, done); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if testAgentDrain(r) != 1 {
		t.Fatal("late completion was not dispatched")
	}
	after, _ := testAgentFreeCounts()
	if after-before != 1 || agentHandleCount(r) != 1 || agentTokenCount() != tokens {
		t.Fatalf("late result leaked: frees=%d handles=%d", after-before, agentHandleCount(r))
	}
}

func TestAgentCancelAfterDispatchDisposesBufferedHandle(t *testing.T) {
	r, a := testAgents(t, true)
	before, _ := testAgentFreeCounts()
	tokens := agentTokenCount()
	result, token, err := testAgentSubmitCreate(a)
	if err != nil {
		t.Fatal(err)
	}
	if !testAgentWaitPending(r) || testAgentDrain(r) != 1 {
		t.Fatal("completion missing")
	}
	done := make(chan struct{})
	abandonOwnedResult(result, token, func(h *agentSession) { h.release(); close(done) })
	receiveAgent(t, done)
	after, _ := testAgentFreeCounts()
	if after-before != 1 || agentHandleCount(r) != 1 || agentTokenCount() != tokens {
		t.Fatal("buffered completion leaked")
	}
}

func TestAgentRuntimeCloseWakesQueuedCall(t *testing.T) {
	r, a := testAgents(t, true)
	tokens := agentTokenCount()
	done := make(chan error, 1)
	go func() {
		v, e := a.Create(context.Background(), "test", AgentCreateOptions{})
		if v != nil {
			e = errors.New("closed runtime returned a handle")
		}
		done <- e
	}()
	if !testAgentWaitPending(r) {
		t.Fatal("completion missing")
	}
	r.Close()
	if err := receiveAgent(t, done); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatal(err)
	}
	if agentHandleCount(r) != 0 || agentTokenCount() != tokens {
		t.Fatal("close leaked agent resources")
	}
	v, e := a.Get(context.Background(), "agent-1")
	if v != nil || !errors.Is(e, ErrRuntimeClosed) {
		t.Fatalf("closed namespace: %v %v", v, e)
	}
}

func TestAgentCanceledSendFreesOnlyLocalTurn(t *testing.T) {
	r, a := testAgents(t, true)
	// First create through the same C queue, under explicit dispatch ownership.
	created := make(chan handleResult[*Agent], 1)
	go func() {
		v, e := a.Create(context.Background(), "test", AgentCreateOptions{})
		created <- handleResult[*Agent]{value: v, err: e}
	}()
	if !testAgentWaitPending(r) || testAgentDrain(r) != 1 {
		t.Fatal("create completion missing")
	}
	result := receiveAgent(t, created)
	if result.err != nil {
		t.Fatal(result.err)
	}
	agent := result.value
	defer runtime.KeepAlive(agent)
	_, before := testAgentFreeCounts()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		v, e := agent.Send(ctx, "still completed", AgentSendOptions{})
		if v != nil {
			e = errors.New("canceled send returned a handle")
		}
		done <- e
	}()
	if !testAgentWaitPending(r) {
		t.Fatal("send completion missing")
	}
	cancel()
	if e := receiveAgent(t, done); !errors.Is(e, context.Canceled) {
		t.Fatal(e)
	}
	if testAgentDrain(r) != 1 {
		t.Fatal("late turn completion missing")
	}
	_, after := testAgentFreeCounts()
	if after-before != 1 || agentHandleCount(r) != 2 {
		t.Fatal("late turn handle leaked")
	}
	loaded := make(chan handleResult[*AgentTurn], 1)
	go func() {
		v, e := agent.GetTurn(context.Background(), "turn-1")
		loaded <- handleResult[*AgentTurn]{value: v, err: e}
	}()
	if !testAgentWaitPending(r) || testAgentDrain(r) != 1 {
		t.Fatal("get_turn completion missing")
	}
	turn := receiveAgent(t, loaded)
	if turn.err != nil {
		t.Fatal(turn.err)
	}
	state, err := turn.value.State()
	if err != nil || state.Status != AgentTurnCompleted || state.Result.Text != "still completed" {
		t.Fatalf("cancellation stopped core work: %+v %v", state, err)
	}
	runtime.KeepAlive(turn.value)
}

func TestAgentRuntimeCloseSerializesWithGetters(t *testing.T) {
	r, a := testAgents(t, false)
	agent := testCreateAgent(t, a)
	turn, err := agent.Send(context.Background(), "work", AgentSendOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.KeepAlive(turn)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for range 20 {
				_, e := agent.State()
				if e != nil && !errors.Is(e, ErrRuntimeClosed) {
					t.Error(e)
				}
			}
		}()
	}
	for range 2 {
		wg.Add(1)
		go func() { defer wg.Done(); <-start; r.Close() }()
	}
	close(start)
	wg.Wait()
	state, err := agent.State()
	if state != nil || !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("state after close: %v %v", state, err)
	}
	config, err := agent.Config()
	if config != nil || !errors.Is(err, ErrRuntimeClosed) {
		t.Fatal(err)
	}
	caps, err := agent.Capabilities()
	if caps != nil || !errors.Is(err, ErrRuntimeClosed) {
		t.Fatal(err)
	}
	ts, err := turn.State()
	if ts != nil || !errors.Is(err, ErrRuntimeClosed) {
		t.Fatal(err)
	}
	if agentHandleCount(r) != 0 {
		t.Fatal("close retained handles")
	}
}

func TestAgentRemoteNamespaceRejectsThroughCore(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/boxes/box1" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"box_id":"box1","name":"service","status":"configured","created_at":"2026-07-14T00:00:00Z","updated_at":"2026-07-14T00:00:00Z","pid":null,"image":"alpine:latest","cpus":1,"memory_mib":256}`)
	}))
	defer server.Close()
	r, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	box, err := r.Get(ctx, "box1")
	if err != nil {
		t.Fatal(err)
	}
	namespace := box.Agents()
	if namespace.native != nil {
		t.Fatal("Agents must be lazy")
	}
	agent, err := namespace.Create(ctx, "opencode", AgentCreateOptions{})
	checkAgentError(t, agent, err, ErrUnsupported)
	if strings.Contains(err.Error(), "not implemented") {
		t.Fatal("stub error reached caller")
	}
	native := namespace.native
	if native == nil {
		t.Fatal("C namespace was not acquired")
	}
	if err := box.Close(); err != nil {
		t.Fatal(err)
	}
	agent, err = namespace.Get(ctx, "ses_existing")
	checkAgentError(t, agent, err, ErrUnsupported)
	if namespace.native != native {
		t.Fatal("namespace did not retain its C handle")
	}
	closed := box.Agents()
	agent, err = closed.Get(ctx, "ses_existing")
	checkAgentError(t, agent, err, ErrInvalidState)
}
