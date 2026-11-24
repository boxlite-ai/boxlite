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
	if err != nil || result.Text != "yes" || string(result.Data) != `{"approved":false,"n":0,"items":[],"child":null}` {
		t.Fatalf("answer=%+v err=%v", result, err)
	}
	denied, err := agent.Respond(ctx, "request-1", AgentPermissionResponse{Approved: false}, AgentControlOptions{})
	checkAgentError(t, denied, err, ErrInvalidArgument)
}

func TestAgentOpaqueDataSurvivesNativeCalls(t *testing.T) {
	_, namespace := testAgents(t, false)
	agent := testCreateAgent(t, namespace)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, data := range []string{
		`1e400`, `-1e400`, `9007199254740993`, `-9223372036854775808`, `18446744073709551615`,
		`{"$serde_json::private::Number":"42"}`,
		`{"$serde_json::private::Number":"hello"}`,
		`[{"$serde_json::private::Number":"42"},{"$serde_json::private::Number":"hello"}]`,
		`0.123456789012345678901`, `[0.123456789012345678901,0.123456789012345678902]`,
	} {
		for _, operation := range []string{"send", "respond"} {
			t.Run(operation+"/"+data, func(t *testing.T) {
				var turn *AgentTurn
				var err error
				if operation == "send" {
					turn, err = agent.Send(ctx, "echo", AgentSendOptions{Data: json.RawMessage(data)})
				} else {
					turn, err = agent.Respond(ctx, "request-1", AgentAnswer{Text: "echo", Data: json.RawMessage(data)}, AgentControlOptions{})
				}
				if err != nil {
					t.Fatal(err)
				}
				defer runtime.KeepAlive(turn)
				state, err := turn.State()
				if err != nil || state == nil || state.Result == nil {
					t.Fatalf("state: %+v, %v", state, err)
				}
				if string(state.Result.Data) != data {
					t.Fatalf("state payload changed: got %s, want %s", state.Result.Data, data)
				}
				loaded, err := agent.GetTurn(ctx, state.ID)
				if err != nil {
					t.Fatal(err)
				}
				defer runtime.KeepAlive(loaded)
				result, err := loaded.Wait(ctx, AgentWaitOptions{})
				if err != nil || result == nil {
					t.Fatalf("wait: %+v, %v", result, err)
				}
				if string(result.Data) != data {
					t.Fatalf("payload changed: got %s, want %s", result.Data, data)
				}
			})
		}
	}
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

func TestAgentUninitializedAndReleasedHandles(t *testing.T) {
	ctx := context.Background()
	for _, namespace := range []*Agents{nil, {}, {box: &Box{}}} {
		created, err := namespace.Create(ctx, "test", AgentCreateOptions{})
		checkAgentError(t, created, err, ErrInvalidState)
		loaded, err := namespace.Get(ctx, "agent-1")
		checkAgentError(t, loaded, err, ErrInvalidState)
	}
	_, namespace := testAgents(t, false)
	released := testCreateAgent(t, namespace)
	released.native.release()
	defer runtime.KeepAlive(released)
	for _, agent := range []*Agent{nil, {}, released} {
		state, err := agent.State()
		checkAgentError(t, state, err, ErrInvalidState)
		turn, err := agent.Send(ctx, "work", AgentSendOptions{})
		checkAgentError(t, turn, err, ErrInvalidState)
	}
	for _, turn := range []*AgentTurn{nil, {}} {
		state, err := turn.State()
		checkAgentError(t, state, err, ErrInvalidState)
		result, err := turn.Wait(ctx, AgentWaitOptions{})
		checkAgentError(t, result, err, ErrInvalidState)
	}
}

func TestAgentAdditionalArgumentsFailBeforeDispatch(t *testing.T) {
	r, namespace := testAgents(t, false)
	agent := testCreateAgent(t, namespace)
	ctx := context.Background()
	turn, err := agent.Send(ctx, "work", AgentSendOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.KeepAlive(turn)
	tokens, handles := agentTokenCount(), agentHandleCount(r)
	cases := []struct {
		name string
		call func() error
	}{
		{"get nil context", func() error { _, e := namespace.Get(nil, "agent-1"); return e }},
		{"turn ID NUL", func() error { _, e := agent.GetTurn(ctx, "turn\x00"); return e }},
		{"response ID NUL", func() error {
			_, e := agent.Respond(ctx, "request\x00", AgentAnswer{}, AgentControlOptions{})
			return e
		}},
		{"steer UTF8", func() error { _, e := turn.Steer(ctx, string([]byte{255}), AgentControlOptions{}); return e }},
		{"interrupt key NUL", func() error { return turn.Interrupt(ctx, AgentControlOptions{IdempotencyKey: "key\x00"}) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			checkAgentError(t, nil, tc.call(), ErrInvalidArgument)
			if agentTokenCount() != tokens || agentHandleCount(r) != handles {
				t.Fatal("invalid argument changed native registrations")
			}
		})
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	result, err := agent.Requests(canceled)
	if result != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled request: %v %v", result, err)
	}
}

// Pause the result-side context check after native completion has been received.
// The first check admits the call; the second lets the test cancel at return.
type agentResultContext struct {
	context.Context
	checks    int
	returning chan struct{}
	release   chan struct{}
}

func (c *agentResultContext) Err() error {
	c.checks++
	if c.checks == 2 {
		close(c.returning)
		<-c.release
	}
	return c.Context.Err()
}

func TestAgentCancellationAfterNativeResultReleasesHandle(t *testing.T) {
	r, namespace := testAgents(t, false)
	agent := testCreateAgent(t, namespace)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	observed := &agentResultContext{Context: ctx, returning: make(chan struct{}), release: make(chan struct{})}
	var once sync.Once
	release := func() { once.Do(func() { close(observed.release) }) }
	t.Cleanup(release)
	_, before := testAgentFreeCounts()
	handles := agentHandleCount(r)
	completed := make(chan handleResult[*AgentTurn], 1)
	go func() {
		turn, err := agent.Send(observed, "work", AgentSendOptions{})
		completed <- handleResult[*AgentTurn]{value: turn, err: err}
	}()
	receiveAgent(t, observed.returning)
	cancel()
	release()
	result := receiveAgent(t, completed)
	if result.value != nil || !errors.Is(result.err, context.Canceled) {
		t.Fatalf("canceled result: %v %v", result.value, result.err)
	}
	_, after := testAgentFreeCounts()
	if after-before != 1 || agentHandleCount(r) != handles {
		t.Fatal("native result survived cancellation at return")
	}
}

func TestAgentNativeSynchronousErrorsLeaveNoRegistrations(t *testing.T) {
	r, namespace := testAgents(t, false)
	agent := testCreateAgent(t, namespace)
	tokens, handles := agentTokenCount(), agentHandleCount(r)
	turn, err := testAgentNativeRejectedSend(context.Background(), agent)
	checkAgentError(t, turn, err, ErrInvalidArgument)
	state, err := testAgentNativeRejectedGetter(agent)
	checkAgentError(t, state, err, ErrInvalidArgument)
	if agentTokenCount() != tokens || agentHandleCount(r) != handles {
		t.Fatal("synchronous C rejection leaked a registration")
	}
	// A rejected submission does not prevent later successful C/core dispatch.
	loaded, err := agent.State()
	if err != nil || loaded.ID != "agent-1" {
		t.Fatalf("getter after rejection: %+v %v", loaded, err)
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

func TestAgentRemoteNamespacePropagatesServerNotFound(t *testing.T) {
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
	checkAgentError(t, agent, err, ErrNotFound)
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
	checkAgentError(t, agent, err, ErrNotFound)
	if namespace.native != native {
		t.Fatal("namespace did not retain its C handle")
	}
	closed := box.Agents()
	agent, err = closed.Get(ctx, "ses_existing")
	checkAgentError(t, agent, err, ErrInvalidState)
}

func TestAgentCancelWaitReleasesOnlyItsObserver(t *testing.T) {
	_, namespace := testAgents(t, false)
	agent := testCreateAgent(t, namespace)
	turn, err := agent.Send(context.Background(), "hold wait observers", AgentSendOptions{})
	if err != nil {
		t.Fatal(err)
	}
	wait := func(ctx context.Context) <-chan error {
		done := make(chan error, 1)
		go func() {
			result, err := turn.Wait(ctx, AgentWaitOptions{})
			if err == nil && (result == nil || result.Text != "finish") {
				err = errors.New("unexpected turn result")
			}
			done <- err
		}()
		return done
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a := wait(ctx)
	b := wait(context.Background())
	defer func() {
		_, _ = agent.Respond(context.Background(), "request-1", AgentAnswer{Text: "finish"}, AgentControlOptions{})
	}()
	waitForNativeObservers(t, agent, "2")
	cancel()
	if err := receiveAgent(t, a); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	waitForNativeObservers(t, agent, "1")
	if _, err := agent.Respond(context.Background(), "request-1", AgentAnswer{Text: "finish"}, AgentControlOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := receiveAgent(t, b); err != nil {
		t.Fatal(err)
	}
}

func waitForNativeObservers(t *testing.T, agent *Agent, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		state, err := agent.State()
		if err != nil {
			t.Fatal(err)
		}
		if state.Cursor == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("native wait observers = %s, want %s", state.Cursor, want)
		}
		runtime.Gosched()
	}
}

func TestAgentWaitTimeoutAndRuntimeClose(t *testing.T) {
	r, namespace := testAgents(t, false)
	agent := testCreateAgent(t, namespace)
	turn, err := agent.Send(context.Background(), "hold wait observers", AgentSendOptions{})
	if err != nil {
		t.Fatal(err)
	}
	zero := time.Duration(0)
	result, err := turn.Wait(context.Background(), AgentWaitOptions{Timeout: &zero})
	checkAgentError(t, result, err, ErrInvalidState)
	done := make(chan error, 1)
	go func() { _, err := turn.Wait(context.Background(), AgentWaitOptions{}); done <- err }()
	waitForNativeObservers(t, agent, "1")
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	if err := receiveAgent(t, done); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatal(err)
	}
}
