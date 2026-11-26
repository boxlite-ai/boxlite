//go:build boxlite_dev && boxlite_agent_test

package boxlite

import (
	"context"
	"errors"
	"fmt"
	"io"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// Done is observed only after the caller has reached the relevant wait/registration.
// This gives tests an interleaving barrier without sleeping or polling goroutines.
type agentObservedContext struct {
	context.Context
	observed chan struct{}
	once     sync.Once
}

func (c *agentObservedContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.observed) })
	return c.Context.Done()
}
func observedAgentContext(ctx context.Context) *agentObservedContext {
	return &agentObservedContext{Context: ctx, observed: make(chan struct{})}
}
func openTestAgentStream(t *testing.T, a *Agent, ctx context.Context, after string) *agentEventStream {
	t.Helper()
	stream, err := a.Events(ctx, AgentEventsOptions{After: after})
	if err != nil {
		t.Fatal(err)
	}
	s := stream.(*agentEventStream)
	t.Cleanup(func() { s.Close(); runtime.KeepAlive(a) })
	return s
}
func waitAgentStream(t *testing.T, s *agentSubscription, predicate func(*agentSubscription) bool) {
	t.Helper()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for {
		s.mu.Lock()
		ready := predicate(s)
		changed := s.changed
		s.mu.Unlock()
		if ready {
			return
		}
		select {
		case <-changed:
		case <-deadline.C:
			t.Fatal("stream state did not arrive")
		}
	}
}
func nextAgent(t *testing.T, s AgentEventStream) *AgentEvent {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	e, err := s.Next(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return e
}
func stopTestDrainer(t *testing.T, r *Runtime) func() {
	t.Helper()
	b := testAgentBlockDrainer(r)
	receiveAgent(t, b.entered)
	var once sync.Once
	release := func() { once.Do(func() { close(b.release) }) }
	t.Cleanup(release)
	return release
}

func TestAgentStreamWaitsForOpen(t *testing.T) {
	r, a := testAgents(t, false)
	agent := testCreateAgent(t, a)
	release := stopTestDrainer(t, r)
	defer release()
	ctx := observedAgentContext(context.Background())
	result := make(chan handleResult[AgentEventStream], 1)
	go func() {
		s, e := agent.Events(ctx, AgentEventsOptions{After: "pending"})
		result <- handleResult[AgentEventStream]{value: s, err: e}
	}()
	receiveAgent(t, ctx.observed)
	if !testAgentWaitPending(r) {
		t.Fatal("opening not posted")
	}
	select {
	case <-result:
		t.Fatal("Events returned before on_open")
	default:
	}
	release()
	got := receiveAgent(t, result)
	if got.err != nil {
		t.Fatal(got.err)
	}
	stream := got.value.(*agentEventStream)
	before := testAgentEventFrees()
	if err := stream.Close(); err != nil {
		t.Fatal(err)
	}
	receiveAgent(t, stream.state.done)
	stream.Close()
	if testAgentEventFrees()-before != 1 {
		t.Fatal("subscription was not freed exactly once")
	}
	if len(r.agentStreamSnapshot()) != 0 {
		t.Fatal("terminal retained callback token")
	}
	stream.state.mu.Lock()
	watch := stream.state.stopWatch
	stream.state.mu.Unlock()
	if watch != nil {
		t.Fatal("terminal retained subscription context watcher")
	}
}

func TestAgentStreamNativeEndAndErrors(t *testing.T) {
	for _, after := range []string{"", "read-error", "open-error"} {
		t.Run(after, func(t *testing.T) {
			r, a := testAgents(t, false)
			agent := testCreateAgent(t, a)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			raw, err := agent.Events(ctx, AgentEventsOptions{After: after})
			if after == "open-error" {
				checkAgentError(t, raw, err, ErrNetwork)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			stream := raw.(*agentEventStream)
			defer stream.Close()
			receiveAgent(t, stream.state.done)
			if after == "read-error" {
				first := nextAgent(t, stream)
				if first.Kind != "first" || first.AgentID != "agent-1" {
					t.Fatalf("event=%+v", first)
				}
				e, err := stream.Next(context.Background())
				checkAgentError(t, e, err, ErrNetwork)
				stream.Close()
				e, err = stream.Next(context.Background())
				checkAgentError(t, e, err, ErrNetwork)
			} else {
				cancel() // Native completion wins over later subscription-context cancellation.
				for range 2 {
					e, err := stream.Next(context.Background())
					if e != nil || !errors.Is(err, io.EOF) {
						t.Fatalf("end=%v %v", e, err)
					}
				}
			}
			if len(r.agentStreamSnapshot()) != 0 {
				t.Fatal("terminal retained callback state")
			}
		})
	}
}

func TestAgentTurnStreamReachesNative(t *testing.T) {
	_, a := testAgents(t, false)
	agent := testCreateAgent(t, a)
	turn, err := agent.Send(context.Background(), "task", AgentSendOptions{})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := turn.Events(context.Background(), AgentEventsOptions{After: "read-error"})
	if err != nil {
		t.Fatal(err)
	}
	stream := raw.(*agentEventStream)
	defer stream.Close()
	first := nextAgent(t, stream)
	if first.Kind != "first" {
		t.Fatalf("event=%+v", first)
	}
	e, err := stream.Next(context.Background())
	checkAgentError(t, e, err, ErrNetwork)
	runtime.KeepAlive(turn)
}

func TestAgentStreamReaderCancellationDoesNotConsume(t *testing.T) {
	_, a := testAgents(t, false)
	agent := testCreateAgent(t, a)
	stream := openTestAgentStream(t, agent, context.Background(), "events")
	waitAgentStream(t, stream.state, func(s *agentSubscription) bool { return len(s.queue) == 2 })
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	e, err := stream.Next(canceled)
	if e != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("read=%v %v", e, err)
	}
	if nextAgent(t, stream).Kind != "first" || nextAgent(t, stream).Kind != "second" {
		t.Fatal("canceled read lost an event")
	}
}

func TestAgentStreamRejectsConcurrentReaders(t *testing.T) {
	_, a := testAgents(t, false)
	agent := testCreateAgent(t, a)
	stream := openTestAgentStream(t, agent, context.Background(), "pending")
	parent, cancel := context.WithCancel(context.Background())
	defer cancel()
	ctx := observedAgentContext(parent)
	done := make(chan error, 1)
	go func() { _, e := stream.Next(ctx); done <- e }()
	receiveAgent(t, ctx.observed)
	e, err := stream.Next(context.Background())
	checkAgentError(t, e, err, ErrInvalidState)
	cancel()
	if err := receiveAgent(t, done); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	stream.state.mu.Lock()
	canceled := stream.state.canceled
	ptr := stream.state.ptr
	stream.state.mu.Unlock()
	if canceled || ptr == nil {
		t.Fatal("read cancellation canceled native subscription")
	}
	stream.Close()
	e, err = stream.Next(context.Background())
	if e != nil || !errors.Is(err, io.EOF) {
		t.Fatalf("close=%v %v", e, err)
	}
	receiveAgent(t, stream.state.done)
}

func TestAgentStreamContextCancellationPreservesPrefix(t *testing.T) {
	_, a := testAgents(t, false)
	agent := testCreateAgent(t, a)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream := openTestAgentStream(t, agent, ctx, "events")
	waitAgentStream(t, stream.state, func(s *agentSubscription) bool { return len(s.queue) == 2 })
	cancel()
	receiveAgent(t, stream.state.done)
	if nextAgent(t, stream).Kind != "first" || nextAgent(t, stream).Kind != "second" {
		t.Fatal("prefix lost")
	}
	for range 2 {
		e, err := stream.Next(context.Background())
		if e != nil || !errors.Is(err, context.Canceled) {
			t.Fatalf("end=%v %v", e, err)
		}
	}
	stream.Close()
	e, err := stream.Next(context.Background())
	if e != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("close erased error: %v", err)
	}
}

func TestAgentStreamLateOpeningAfterCancellation(t *testing.T) {
	for _, after := range []string{"pending", "open-error"} {
		t.Run(after, func(t *testing.T) {
			r, a := testAgents(t, false)
			agent := testCreateAgent(t, a)
			release := stopTestDrainer(t, r)
			defer release()
			parent, cancel := context.WithCancel(context.Background())
			defer cancel()
			ctx := observedAgentContext(parent)
			done := make(chan handleResult[AgentEventStream], 1)
			go func() {
				v, e := agent.Events(ctx, AgentEventsOptions{After: after})
				done <- handleResult[AgentEventStream]{value: v, err: e}
			}()
			receiveAgent(t, ctx.observed)
			if !testAgentWaitPending(r) {
				t.Fatal("native open not queued")
			}
			states := r.agentStreamSnapshot()
			if len(states) != 1 {
				t.Fatal("missing opening state")
			}
			before := testAgentEventFrees()
			cancel()
			result := receiveAgent(t, done)
			if result.value != nil || !errors.Is(result.err, context.Canceled) {
				t.Fatalf("opening=%+v", result)
			}
			release()
			receiveAgent(t, states[0].done)
			want := 0
			if after == "pending" {
				want = 1
			}
			if testAgentEventFrees()-before != want {
				t.Fatal("late opening ownership mismatch")
			}
			if len(r.agentStreamSnapshot()) != 0 {
				t.Fatal("late opening retained callback token")
			}
		})
	}
}

func TestAgentStreamCountOverflowKeepsPrefixAndDrainerResponsive(t *testing.T) {
	_, a := testAgents(t, false)
	agent := testCreateAgent(t, a)
	stream := openTestAgentStream(t, agent, context.Background(), "many")
	receiveAgent(t, stream.state.done)
	stream.state.mu.Lock()
	count := len(stream.state.queue)
	stream.state.mu.Unlock()
	if count != agentStreamCount {
		t.Fatalf("buffered %d events", count)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	requests, err := agent.Requests(ctx)
	if err != nil || len(requests) != 1 {
		t.Fatalf("slow reader blocked request: %v", err)
	}
	for i := range agentStreamCount {
		if e := nextAgent(t, stream); e.Kind != fmt.Sprint(i) {
			t.Fatalf("event %d=%+v", i, e)
		}
	}
	for range 2 {
		e, err := stream.Next(context.Background())
		checkAgentError(t, e, err, ErrResourceExhausted)
	}
}

func TestAgentStreamByteBoundaries(t *testing.T) {
	tests := []struct {
		name, after  string
		count, bytes int
		overflow     bool
	}{
		{"exact record", fmt.Sprintf("bytes:%d", agentStreamBytes), 1, agentStreamBytes, false},
		{"oversize record", fmt.Sprintf("bytes:%d", agentStreamBytes+1), 0, 0, true},
		{"exact aggregate", fmt.Sprintf("bytes:%d,%d", agentStreamBytes/2, agentStreamBytes/2), 2, agentStreamBytes, false},
		{"aggregate one over", fmt.Sprintf("bytes:%d,%d", agentStreamBytes/2, agentStreamBytes/2+1), 1, agentStreamBytes / 2, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r, a := testAgents(t, false)
			agent := testCreateAgent(t, a)
			release := stopTestDrainer(t, r)
			defer release()
			ctx := observedAgentContext(context.Background())
			result := make(chan handleResult[AgentEventStream], 1)
			go func() {
				v, e := agent.Events(ctx, AgentEventsOptions{After: tt.after})
				result <- handleResult[AgentEventStream]{value: v, err: e}
			}()
			receiveAgent(t, ctx.observed)
			if !testAgentWaitPending(r) {
				t.Fatal("native open missing")
			}
			var before runtime.MemStats
			runtime.ReadMemStats(&before)
			release()
			got := receiveAgent(t, result)
			if got.err != nil {
				t.Fatal(got.err)
			}
			stream := got.value.(*agentEventStream)
			defer stream.Close()
			receiveAgent(t, stream.state.done)
			var after runtime.MemStats
			runtime.ReadMemStats(&after)
			stream.state.mu.Lock()
			count, bytes, err := len(stream.state.queue), stream.state.bytes, stream.state.err
			stream.state.mu.Unlock()
			if count != tt.count || bytes != tt.bytes {
				t.Fatalf("buffer count=%d bytes=%d", count, bytes)
			}
			if tt.overflow {
				checkAgentError(t, nil, err, ErrResourceExhausted)
			} else if err != nil {
				t.Fatal(err)
			}
			if tt.count == 0 && after.TotalAlloc-before.TotalAlloc >= 1024*1024 {
				t.Fatalf("oversized record allocated %d Go bytes before rejection", after.TotalAlloc-before.TotalAlloc)
			}
		})
	}
}

func TestAgentStreamRuntimeCloseOverridesBufferAndError(t *testing.T) {
	r, a := testAgents(t, false)
	agent := testCreateAgent(t, a)
	stream := openTestAgentStream(t, agent, context.Background(), "read-error")
	receiveAgent(t, stream.state.done) // Preserve a native error and buffered prefix first.
	r.Close()
	stream.state.mu.Lock()
	buffered := len(stream.state.queue)
	stream.state.mu.Unlock()
	if buffered != 0 {
		t.Fatal("runtime retained a completed stream's buffered events")
	}
	e, err := stream.Next(context.Background())
	if e != nil || !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("runtime end=%v %v", e, err)
	}
}

func TestAgentStreamRuntimeCloseWithPendingConnect(t *testing.T) {
	r, a := testAgents(t, false)
	agent := testCreateAgent(t, a)
	ctx := observedAgentContext(context.Background())
	done := make(chan error, 1)
	go func() {
		s, e := agent.Events(ctx, AgentEventsOptions{After: "open-pending"})
		if s != nil {
			e = errors.New("closed opening returned a stream")
		}
		done <- e
	}()
	receiveAgent(t, ctx.observed)
	states := r.agentStreamSnapshot()
	if len(states) != 1 {
		t.Fatal("pending opening missing")
	}
	closed := make(chan struct{})
	go func() { r.Close(); close(closed) }()
	receiveAgent(t, closed)
	if e := receiveAgent(t, done); !errors.Is(e, ErrRuntimeClosed) {
		t.Fatal(e)
	}
	receiveAgent(t, states[0].done)
	if len(r.agentStreamSnapshot()) != 0 {
		t.Fatal("pending open leaked token")
	}
}

func TestAgentStreamRuntimeCloseWithFullQueueAndLateOpen(t *testing.T) {
	r, a := testAgents(t, false)
	agent := testCreateAgent(t, a)
	release := stopTestDrainer(t, r)
	defer release()
	ctx := observedAgentContext(context.Background())
	done := make(chan error, 1)
	go func() {
		s, e := agent.Events(ctx, AgentEventsOptions{After: "continuous"})
		if s != nil {
			e = errors.New("closed opening returned a stream")
		}
		done <- e
	}()
	receiveAgent(t, ctx.observed)
	// The real C queue is full while its drainer is held before on_open.
	if !testAgentWaitQueue(r, 4096) {
		t.Fatal("native producer did not fill queue")
	}
	states := r.agentStreamSnapshot()
	if len(states) != 1 {
		t.Fatal("missing opening")
	}
	closed := make(chan struct{})
	go func() { r.Close(); close(closed) }()
	receiveAgent(t, r.closing)
	if e := receiveAgent(t, done); !errors.Is(e, ErrRuntimeClosed) {
		t.Fatal(e)
	}
	release()
	receiveAgent(t, closed)
	receiveAgent(t, states[0].done)
	if len(r.agentStreamSnapshot()) != 0 {
		t.Fatal("late-open terminal tracking leaked")
	}
}

func TestAgentStreamTwoRuntimesDrainIndependently(t *testing.T) {
	first, a := testAgents(t, false)
	agent := testCreateAgent(t, a)
	stream := openTestAgentStream(t, agent, context.Background(), "pending")
	release := stopTestDrainer(t, first)
	defer release()
	second, b := testAgents(t, false)
	other := testCreateAgent(t, b)
	closed := make(chan struct{})
	go func() { first.Close(); close(closed) }()
	receiveAgent(t, first.closing)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	turn, err := other.Send(ctx, "independent", AgentSendOptions{})
	if err != nil {
		t.Fatal(err)
	}
	result, err := turn.Wait(ctx, AgentWaitOptions{})
	if err != nil || result.Text != "independent" {
		t.Fatalf("second runtime blocked: %+v %v", result, err)
	}
	release()
	receiveAgent(t, closed)
	receiveAgent(t, stream.state.done)
	second.Close()
	runtime.KeepAlive(turn)
}

func TestAgentStreamInvalidOpeningNeverRegisters(t *testing.T) {
	r, a := testAgents(t, false)
	agent := testCreateAgent(t, a)
	for _, cursor := range []string{"bad\x00cursor", string([]byte{255})} {
		stream, err := agent.Events(context.Background(), AgentEventsOptions{After: cursor})
		checkAgentError(t, stream, err, ErrInvalidArgument)
	}
	stream, err := agent.Events(nil, AgentEventsOptions{})
	checkAgentError(t, stream, err, ErrInvalidArgument)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	stream, err = agent.Events(ctx, AgentEventsOptions{})
	if stream != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled open=%v %v", stream, err)
	}
	if len(r.agentStreamSnapshot()) != 0 {
		t.Fatal("invalid opening registered native callback state")
	}
}

func TestAgentStreamCloseDiscardsUnreadEvents(t *testing.T) {
	_, a := testAgents(t, false)
	agent := testCreateAgent(t, a)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream := openTestAgentStream(t, agent, ctx, "events")
	waitAgentStream(t, stream.state, func(s *agentSubscription) bool { return len(s.queue) == 2 })
	stream.Close()
	stream.Close()
	receiveAgent(t, stream.state.done)
	cancel()
	e, err := stream.Next(context.Background())
	if e != nil || !errors.Is(err, io.EOF) {
		t.Fatalf("close=%v %v", e, err)
	}
	stream.state.mu.Lock()
	count, bytes := len(stream.state.queue), stream.state.bytes
	stream.state.mu.Unlock()
	if count != 0 || bytes != 0 {
		t.Fatal("Close retained unread records")
	}
}

func TestAgentStreamConcurrentCloseNextAndRuntime(t *testing.T) {
	for range 8 {
		r, a := testAgents(t, false)
		agent := testCreateAgent(t, a)
		stream := openTestAgentStream(t, agent, context.Background(), "pending")
		ctx := observedAgentContext(context.Background())
		read := make(chan error, 1)
		go func() { _, e := stream.Next(ctx); read <- e }()
		receiveAgent(t, ctx.observed)
		before := testAgentEventFrees()
		start := make(chan struct{})
		var wg sync.WaitGroup
		for range 2 {
			wg.Add(1)
			go func() { defer wg.Done(); <-start; stream.Close() }()
		}
		wg.Add(1)
		go func() { defer wg.Done(); <-start; r.Close() }()
		close(start)
		wg.Wait()
		e := receiveAgent(t, read)
		if !errors.Is(e, io.EOF) && !errors.Is(e, ErrRuntimeClosed) {
			t.Fatal(e)
		}
		receiveAgent(t, stream.state.done)
		if testAgentEventFrees()-before != 1 {
			t.Fatal("concurrent close double-freed native subscription")
		}
	}
}

func TestAgentStreamDecodeRecovery(t *testing.T) {
	_, ns := testAgents(t, false)
	agent := testCreateAgent(t, ns)
	stream := openTestAgentStream(t, agent, context.Background(), "after-response")
	if first := nextAgent(t, stream); first.Kind != "first" {
		t.Fatalf("first event: %+v", first)
	}
	testDeliverAgentRecord(stream.state, `{"agent_id":"a","turn_id":null,"kind":7,"cursor":null,"data":"sensitive-payload"}`)
	event, err := stream.Next(context.Background())
	var decode *AgentEventDecodeError
	if event != nil || !errors.As(err, &decode) || !strings.Contains(err.Error(), "kind") || strings.Contains(err.Error(), "sensitive-payload") {
		t.Fatalf("unexpected decode result: %v %v", event, err)
	}
	stream.state.mu.Lock()
	active := !stream.state.canceled && stream.state.ptr != nil
	stream.state.mu.Unlock()
	if !active {
		t.Fatal("decode error released the native subscription")
	}
	if _, err := agent.Respond(context.Background(), "request-1", AgentAnswer{Text: "continue"}, AgentControlOptions{}); err != nil {
		t.Fatal(err)
	}
	got := nextAgent(t, stream)
	if got.Kind != "future" || string(got.Data) != "1e+400" {
		t.Fatalf("later event: %+v", got)
	}
	receiveAgent(t, stream.state.done)
	if _, err := stream.Next(context.Background()); !errors.Is(err, io.EOF) {
		t.Fatal(err)
	}

}

func TestAgentStreamDecodeRuntimePrecedence(t *testing.T) {
	r, ns := testAgents(t, false)
	stream := openTestAgentStream(t, testCreateAgent(t, ns), context.Background(), "pending")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r.Close()
	if _, err := stream.Next(ctx); !errors.Is(err, ErrRuntimeClosed) {
		t.Fatalf("both closed: %v", err)
	}
}

// Pause the first Err observation until shutdown and read cancellation overlap.
type agentReadBarrierContext struct {
	context.Context
	entered chan struct{}
	once    sync.Once
}

func (c *agentReadBarrierContext) Err() error {
	c.once.Do(func() {
		close(c.entered)
		<-c.Done()
	})
	return c.Context.Err()
}

func TestAgentStreamRuntimeClosesDuringReadErrorCheck(t *testing.T) {
	r, ns := testAgents(t, false)
	stream := openTestAgentStream(t, testCreateAgent(t, ns), context.Background(), "pending")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	read := &agentReadBarrierContext{Context: ctx, entered: make(chan struct{})}
	result := make(chan error, 1)
	go func() {
		_, err := stream.Next(read)
		result <- err
	}()
	receiveAgent(t, read.entered)
	closed := make(chan error, 1)
	go func() { closed <- r.Close() }()
	receiveAgent(t, r.closing)
	cancel()
	if err := receiveAgent(t, result); !errors.Is(err, ErrRuntimeClosed) {
		t.Errorf("Next during runtime shutdown returned %v, want ErrRuntimeClosed", err)
	}
	if err := receiveAgent(t, closed); err != nil {
		t.Fatal(err)
	}
}

func TestAgentStreamDecodeClose(t *testing.T) {
	_, ns := testAgents(t, false)
	stream := openTestAgentStream(t, testCreateAgent(t, ns), context.Background(), "pending")
	testDeliverAgentRecord(stream.state, "{}")
	var decode *AgentEventDecodeError
	if _, err := stream.Next(context.Background()); !errors.As(err, &decode) {
		t.Fatal(err)
	}
	if err := stream.Close(); err != nil {
		t.Fatal(err)
	}
	receiveAgent(t, stream.state.done)
	if _, err := stream.Next(context.Background()); !errors.Is(err, io.EOF) {
		t.Fatal(err)
	}
}

func TestAgentStreamDecodePreservesNativeError(t *testing.T) {
	_, ns := testAgents(t, false)
	stream := openTestAgentStream(t, testCreateAgent(t, ns), context.Background(), "read-error")
	receiveAgent(t, stream.state.done)
	// Corrupt the one buffered record after the real native terminal arrives.
	s := stream.state
	s.mu.Lock()
	s.queue[0] = []byte("{}")
	s.bytes = len(s.queue[0])
	s.mu.Unlock()
	var decode *AgentEventDecodeError
	if _, err := stream.Next(context.Background()); !errors.As(err, &decode) {
		t.Fatal(err)
	}
	e, err := stream.Next(context.Background())
	checkAgentError(t, e, err, ErrNetwork)
}

func TestAgentStreamShutdownDispatchesOnlySubscriptions(t *testing.T) {
	r, ns := testAgents(t, false)
	stream := openTestAgentStream(t, testCreateAgent(t, ns), context.Background(), "pending")
	r.stopDrain()
	b, token := testQueueUnrelatedCallback(r)
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	receiveAgent(t, stream.state.done)
	select {
	case <-b.entered:
		t.Fatal("shutdown dispatched an unrelated callback")
	default:
		token.Delete()
	}
}

func TestAgentStreamCanceledBeforeNativeEOF(t *testing.T) {
	_, ns := testAgents(t, false)
	a := testCreateAgent(t, ns)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := openTestAgentStream(t, a, ctx, "after-response")
	// Hold back AfterFunc delivery while the real native terminal arrives.
	if !s.state.stopWatch() {
		t.Fatal("subscription watcher already ran")
	}
	cancel()
	if _, err := a.Respond(context.Background(), "request-1", AgentAnswer{Text: "continue"}, AgentControlOptions{}); err != nil {
		t.Fatal(err)
	}
	receiveAgent(t, s.state.done)
	for _, kind := range []string{"first", "future"} {
		if e := nextAgent(t, s); e.Kind != kind {
			t.Fatalf("event = %v, want %s", e, kind)
		}
	}
	if _, err := s.Next(context.Background()); !errors.Is(err, context.Canceled) {
		t.Fatalf("native EOF after subscription cancellation returned %v", err)
	}
}

func TestAgentStreamNativeRejectsOpen(t *testing.T) {
	r, ns := testAgents(t, false)
	a := testCreateAgent(t, ns)
	stream, err := testAgentRejectedOpen(a)
	checkAgentError(t, stream, err, ErrInvalidArgument)
	if len(r.agentStreamSnapshot()) != 0 || len(r.agentBufferSnapshot()) != 0 {
		t.Fatal("synchronous rejection retained subscription state")
	}
}

func TestAgentStreamNilReadContextPreservesEvent(t *testing.T) {
	_, ns := testAgents(t, false)
	stream := openTestAgentStream(t, testCreateAgent(t, ns), context.Background(), "after-response")
	event, err := stream.Next(nil)
	checkAgentError(t, event, err, ErrInvalidArgument)
	if first := nextAgent(t, stream); first.Kind != "first" {
		t.Fatalf("after invalid read: %+v", first)
	}
}
