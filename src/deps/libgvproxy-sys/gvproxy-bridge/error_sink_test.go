package main

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// ── Init phase ────────────────────────────────────────────────────────

func TestErrSink_Init_NilSuccessUnblocksWaitWithNil(t *testing.T) {
	s := NewErrSink(42)

	go func() { s.Init("virtualnetwork.New", nil) }()

	if err := s.WaitInit(); err != nil {
		t.Fatalf("expected nil from successful Init; got %v", err)
	}
}

func TestErrSink_Init_ErrorWrapsSourceAndUnblocks(t *testing.T) {
	s := NewErrSink(42)
	cause := errors.New("EADDRINUSE")

	go func() { s.Init("virtualnetwork.New", cause) }()

	err := s.WaitInit()
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	// Must mention the source so the operator can locate it
	if !strings.Contains(err.Error(), "virtualnetwork.New") {
		t.Errorf("error must mention source; got %q", err.Error())
	}
	// Must wrap the cause so callers can errors.Is/As against it
	if !errors.Is(err, cause) {
		t.Errorf("error must wrap cause; got %v", err)
	}
}

func TestErrSink_WaitInit_BlocksUntilInitCalled(t *testing.T) {
	s := NewErrSink(42)

	done := make(chan struct{})
	go func() {
		_ = s.WaitInit()
		close(done)
	}()

	// Confirm WaitInit is blocked
	select {
	case <-done:
		t.Fatal("WaitInit returned before Init was called")
	case <-time.After(20 * time.Millisecond):
	}

	s.Init("test", nil)

	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("WaitInit did not return after Init")
	}
}

// ── Runtime phase ─────────────────────────────────────────────────────

func TestErrSink_Runtime_NilIsNoop(t *testing.T) {
	s := NewErrSink(42)
	s.Runtime("vn.AcceptQemu", nil) // must not panic, must not enqueue
	if re := s.PollRuntime(); re != nil {
		t.Errorf("expected empty queue after nil Runtime; got %+v", re)
	}
}

func TestErrSink_Runtime_EnqueuesAndPollDrainsFIFO(t *testing.T) {
	s := NewErrSink(42)

	s.Runtime("AcceptVfkit", errors.New("first"))
	s.Runtime("AcceptQemu", errors.New("second"))
	s.Runtime("OverrideTCPHandler", errors.New("third"))

	want := []struct{ source, msg string }{
		{"AcceptVfkit", "first"},
		{"AcceptQemu", "second"},
		{"OverrideTCPHandler", "third"},
	}
	for i, w := range want {
		re := s.PollRuntime()
		if re == nil {
			t.Fatalf("poll %d: expected event, got nil", i)
		}
		if re.Source != w.source {
			t.Errorf("poll %d: source = %q, want %q", i, re.Source, w.source)
		}
		if re.Err.Error() != w.msg {
			t.Errorf("poll %d: err = %q, want %q", i, re.Err.Error(), w.msg)
		}
	}
	if re := s.PollRuntime(); re != nil {
		t.Errorf("expected empty queue after draining 3 events; got %+v", re)
	}
}

func TestErrSink_Runtime_FullQueueDropsAndIncrementsCounter(t *testing.T) {
	s := NewErrSink(42)

	// Saturate: send queueSize+5 events
	for i := 0; i < runtimeErrQueueSize+5; i++ {
		s.Runtime("AcceptQemu", fmt.Errorf("event %d", i))
	}

	dropped := s.DroppedRuntimeCount()
	if dropped != 5 {
		t.Errorf("expected 5 dropped events (sent %d into queue of %d); got %d",
			runtimeErrQueueSize+5, runtimeErrQueueSize, dropped)
	}

	// The first queueSize events made it in (FIFO)
	for i := 0; i < runtimeErrQueueSize; i++ {
		re := s.PollRuntime()
		if re == nil {
			t.Fatalf("poll %d: expected event in saturated queue, got nil", i)
		}
		if re.Err.Error() != fmt.Sprintf("event %d", i) {
			t.Errorf("poll %d: out-of-order, got %q (expected event %d)",
				i, re.Err.Error(), i)
		}
	}
	if re := s.PollRuntime(); re != nil {
		t.Errorf("expected empty queue, got %+v", re)
	}
}

func TestErrSink_Runtime_ProducerNeverBlocksUnderBackpressure(t *testing.T) {
	s := NewErrSink(42)

	// Fill the queue with no reader
	done := make(chan struct{})
	go func() {
		// Twice the queue size — must complete without a reader
		for i := 0; i < runtimeErrQueueSize*2; i++ {
			s.Runtime("AcceptVfkit", fmt.Errorf("event %d", i))
		}
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("Runtime() blocked the producer when queue was full — must drop instead")
	}
	if got := s.DroppedRuntimeCount(); got != int64(runtimeErrQueueSize) {
		t.Errorf("expected %d dropped, got %d", runtimeErrQueueSize, got)
	}
}

func TestErrSink_Runtime_ConcurrentProducersAreSafe(t *testing.T) {
	s := NewErrSink(42)

	const producers = 10
	const each = 20

	var wg sync.WaitGroup
	wg.Add(producers)
	for p := 0; p < producers; p++ {
		go func(pid int) {
			defer wg.Done()
			for i := 0; i < each; i++ {
				s.Runtime(fmt.Sprintf("producer%d", pid), fmt.Errorf("p%d-e%d", pid, i))
			}
		}(p)
	}
	wg.Wait()

	// Drain whatever made it (queueSize at most). The point is no
	// panic, no data race — the counts add up.
	var observed int
	for s.PollRuntime() != nil {
		observed++
	}
	totalSent := producers * each
	totalDropped := int(s.DroppedRuntimeCount())
	if observed+totalDropped != totalSent {
		t.Errorf("observed (%d) + dropped (%d) != sent (%d) — events lost without tracking",
			observed, totalDropped, totalSent)
	}
}

// ── Source-naming contract ────────────────────────────────────────────

func TestErrSink_RuntimeError_StringIncludesSourceTimestampAndCause(t *testing.T) {
	s := NewErrSink(42)
	s.Runtime("listener.Accept", errors.New("use of closed network connection"))

	re := s.PollRuntime()
	if re == nil {
		t.Fatal("expected event")
	}
	rendered := re.String()
	for _, want := range []string{"listener.Accept", "use of closed network connection"} {
		if !strings.Contains(rendered, want) {
			t.Errorf("rendered %q must contain %q", rendered, want)
		}
	}
	// RFC3339Nano stamp roughly: yyyy-mm-ddTHH:MM:SS.nnnnnnnnnZ — at least
	// must start with the year prefix and contain a "T".
	if !strings.Contains(rendered, "T") || !strings.Contains(rendered, "Z") {
		t.Errorf("rendered %q must contain RFC3339 timestamp shape", rendered)
	}
}
