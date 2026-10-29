package cpumonitor

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"math"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

func testMonitor() *Monitor {
	return New(slog.New(slog.NewTextHandler(io.Discard, nil)), 5*time.Second, nil, nil)
}

func TestCPUIncidentThresholdAndRearm(t *testing.T) {
	m := testMonitor()
	start := time.Unix(1700000000, 0)
	for second := 0; second < 300; second += 5 {
		m.Observe(start.Add(time.Duration(second)*time.Second), 80.1)
	}
	if len(m.triggers) != 0 {
		t.Fatal("triggered before five minutes")
	}
	m.Observe(start.Add(300*time.Second), 80.1)
	if len(m.triggers) != 1 {
		t.Fatal("did not trigger after five minutes above 80 percent")
	}
	<-m.triggers
	m.Observe(start.Add(305*time.Second), 80)
	for second := 310; second < 610; second += 5 {
		m.Observe(start.Add(time.Duration(second)*time.Second), 80.1)
	}
	if len(m.triggers) != 0 {
		t.Fatal("rearmed before a fresh five minutes")
	}
	m.Observe(start.Add(610*time.Second), 80.1)
	if len(m.triggers) != 1 {
		t.Fatal("did not rearm after equality boundary")
	}
}

func TestCPUIncidentContinuity(t *testing.T) {
	for _, test := range []struct {
		name    string
		percent float64
		skip    bool
	}{
		{"threshold", 80, false}, {"nan", math.NaN(), false}, {"infinity", math.Inf(1), false},
		{"out of range", 101, false}, {"negative", -1, false}, {"one missing sample", 80.1, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			m := testMonitor()
			start := time.Unix(1700000000, 0)
			for second := 0; second <= 295; second += 5 {
				m.Observe(start.Add(time.Duration(second)*time.Second), 80.1)
			}
			if !test.skip {
				m.Observe(start.Add(300*time.Second), test.percent)
			}
			for second := 305; second < 605; second += 5 {
				m.Observe(start.Add(time.Duration(second)*time.Second), 80.1)
			}
			if len(m.triggers) != 0 {
				t.Fatal("bridged discontinuity")
			}
			m.Observe(start.Add(605*time.Second), 80.1)
			if len(m.triggers) != 1 {
				t.Fatal("failed to restart pending timer")
			}
		})
	}
}

func TestCPUIncidentCaptureUsesNextTwoMinutes(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		m := testMonitor()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		start := time.Now()
		m.sample = func(context.Context) (map[string]counter, bool) {
			seconds := time.Since(start).Seconds()
			return map[string]counter{"older": {identity: "old", seconds: 100000 + seconds}, "largest": {identity: "new", seconds: 10 + 2*seconds}}, true
		}
		reported := make(chan Incident, 1)
		m.report = func(_ context.Context, event Incident) (bool, error) { reported <- event; return false, nil }
		go m.Run(ctx)
		for second := -300; second <= 0; second += 5 {
			m.Observe(start.Add(time.Duration(second)*time.Second), 99)
		}
		synctest.Wait()
		m.Observe(start.Add(5*time.Second), 20) // recovery must not cancel the existing capture
		time.Sleep(119 * time.Second)
		if len(reported) != 0 {
			t.Fatal("capture ended early")
		}
		time.Sleep(time.Second)
		synctest.Wait()
		event := <-reported
		if event.BoxID == nil || *event.BoxID != "largest" || event.CPUSeconds != 240 || !event.SamplingComplete {
			t.Fatalf("wrong attribution: %+v", event)
		}
		if event.WindowEndedAt.Sub(event.WindowStartedAt) != 2*time.Minute {
			t.Fatal("wrong capture window")
		}
		cancel()
		synctest.Wait()
	})
}

func TestCPUIncidentWindowHandlesLifecycleAndMissingCounters(t *testing.T) {
	w := window{complete: true}
	w.add(map[string]counter{"exited": {identity: "one", seconds: 10}, "restarted": {identity: "old", seconds: 100}, "reset": {identity: "same", seconds: 90}}, true)
	w.add(map[string]counter{"exited": {identity: "one", seconds: 30}, "restarted": {identity: "new", seconds: 9000}, "reset": {identity: "same", seconds: 1}, "new": {identity: "new", seconds: 99999}}, true)
	w.add(map[string]counter{"restarted": {identity: "new", seconds: 9005}, "reset": {identity: "same", seconds: 2}, "new": {identity: "new", seconds: 100001}}, false)
	event := w.finish(Incident{})
	if event.BoxID == nil || *event.BoxID != "exited" || event.CPUSeconds != 20 || event.SamplingComplete {
		t.Fatalf("bad lifecycle ranking: %+v", event)
	}
	w = window{complete: true}
	w.add(map[string]counter{"b": {identity: "b", seconds: 10}, "a": {identity: "a", seconds: 10}}, true)
	w.add(map[string]counter{"b": {identity: "b", seconds: 20}, "a": {identity: "a", seconds: 20}}, true)
	if got := w.finish(Incident{}); got.BoxID == nil || *got.BoxID != "a" {
		t.Fatalf("tie not deterministic: %+v", got)
	}
	if got := (&window{complete: false}).finish(Incident{}); got.BoxID != nil || got.CPUSeconds != 0 || got.SamplingComplete {
		t.Fatal("invented attribution")
	}
}

func TestCPUIncidentUploadRetriesAndDropsPermanentFailures(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		m := testMonitor()
		ctx, cancel := context.WithCancel(context.Background())
		attempts := make(chan string, 4)
		attemptCount := 0
		m.report = func(_ context.Context, event Incident) (bool, error) {
			attempts <- event.EventID
			attemptCount++
			if attemptCount == 1 {
				return true, errors.New("unavailable")
			}
			if event.EventID == "poison" {
				return false, errors.New("invalid")
			}
			return false, nil
		}
		m.reports <- Incident{EventID: "first"}
		m.reports <- Incident{EventID: "poison"}
		m.reports <- Incident{EventID: "last"}
		go m.upload(ctx)
		synctest.Wait()
		if len(attempts) != 1 {
			t.Fatal("retry was not delayed")
		}
		time.Sleep(30 * time.Second)
		synctest.Wait()
		if len(attempts) != 4 {
			t.Fatalf("expected four attempts, got %d", len(attempts))
		}
		got := []string{<-attempts, <-attempts, <-attempts, <-attempts}
		if strings.Join(got, ",") != "first,first,poison,last" {
			t.Fatalf("attempts: %v", got)
		}
		cancel()
		synctest.Wait()
	})
}

func TestCPUIncidentCaptureCancellation(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		m := testMonitor()
		ctx, cancel := context.WithCancel(context.Background())
		m.sample = func(ctx context.Context) (map[string]counter, bool) { <-ctx.Done(); return nil, false }
		m.report = func(context.Context, Incident) (bool, error) {
			t.Error("uploaded cancelled capture")
			return false, nil
		}
		start := time.Now()
		for second := -300; second <= 0; second += 5 {
			m.Observe(start.Add(time.Duration(second)*time.Second), 99)
		}
		done := make(chan struct{})
		go func() { defer close(done); m.Run(ctx) }()
		synctest.Wait()
		cancel()
		<-done
	})
}
