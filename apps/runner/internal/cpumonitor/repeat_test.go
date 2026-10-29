package cpumonitor

import (
	"context"
	"math"
	"testing"
	"testing/synctest"
	"time"
)

func observeHighFor(m *Monitor, duration time.Duration) {
	for elapsed := time.Duration(0); elapsed < duration; elapsed += 5 * time.Second {
		time.Sleep(5 * time.Second)
		m.Observe(time.Now(), 80.1)
		synctest.Wait()
	}
}

func runRepeatingMonitor(m *Monitor) (chan Incident, func()) {
	ctx, cancel := context.WithCancel(context.Background())
	start := time.Now()
	m.sample = func(context.Context) (map[string]counter, bool) {
		return map[string]counter{"busy": {identity: "process", seconds: time.Since(start).Seconds()}}, true
	}
	reports := make(chan Incident, 16)
	m.report = func(_ context.Context, event Incident) (bool, error) { reports <- event; return false, nil }
	go m.Run(ctx)
	return reports, func() { cancel(); synctest.Wait() }
}

func TestCPUIncidentRepeatsConsecutiveWindows(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		m := testMonitor()
		reports, stop := runRepeatingMonitor(m)
		defer stop()
		start := time.Now()
		m.Observe(start, 80.1)
		observeHighFor(m, 7*time.Minute)
		if len(reports) != 1 {
			t.Fatalf("expected first two-minute report, got %d", len(reports))
		}
		first := <-reports
		observeHighFor(m, 2*time.Minute)
		if len(reports) != 1 {
			t.Fatalf("expected second consecutive report, got %d", len(reports))
		}
		second := <-reports
		if first.EventID == "" || second.EventID == "" || first.EventID == second.EventID {
			t.Fatal("windows must have distinct event IDs")
		}
		for index, event := range []Incident{first, second} {
			wantStart := start.Add(time.Duration(5+2*index) * time.Minute)
			if !event.HighCPUSince.Equal(start) || !event.WindowStartedAt.Equal(wantStart) || !event.WindowEndedAt.Equal(wantStart.Add(2*time.Minute)) {
				t.Fatalf("wrong window %d: %+v", index, event)
			}
			if event.BoxID == nil || *event.BoxID != "busy" || event.CPUSeconds != 120 {
				t.Fatalf("window did not reset attribution: %+v", event)
			}
		}
	})
}

func TestCPUIncidentRepeatStopsAndRequalifies(t *testing.T) {
	for _, test := range []struct {
		name  string
		value float64
		skip  bool
	}{{"recovery", 80, false}, {"invalid", math.NaN(), false}, {"missing", 0, true}} {
		t.Run(test.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				m := testMonitor()
				reports, stop := runRepeatingMonitor(m)
				defer stop()
				m.Observe(time.Now(), 80.1)
				observeHighFor(m, 5*time.Minute+15*time.Second)
				time.Sleep(5 * time.Second)
				if !test.skip {
					m.Observe(time.Now(), test.value)
				}
				time.Sleep(100 * time.Second)
				synctest.Wait()
				if len(reports) != 1 {
					t.Fatalf("interruption lost active capture: %d", len(reports))
				}
				<-reports
				time.Sleep(2 * time.Minute)
				synctest.Wait()
				if len(reports) != 0 {
					t.Fatal("continued capture after interruption")
				}
				newStart := time.Now()
				m.Observe(newStart, 80.1)
				observeHighFor(m, 7*time.Minute)
				if len(reports) != 1 {
					t.Fatalf("did not requalify after a fresh five minutes: %d", len(reports))
				}
				if event := <-reports; !event.HighCPUSince.Equal(newStart) || !event.WindowStartedAt.Equal(newStart.Add(5*time.Minute)) {
					t.Fatalf("reused interrupted episode: %+v", event)
				}
			})
		})
	}
}

func TestCPUIncidentRejectsStaleQueuedTrigger(t *testing.T) {
	for _, recover := range []bool{false, true} {
		synctest.Test(t, func(t *testing.T) {
			m := testMonitor()
			start := time.Now()
			for second := -300; second <= 0; second += 5 {
				m.Observe(start.Add(time.Duration(second)*time.Second), 99)
			}
			time.Sleep(15 * time.Second)
			if recover {
				m.Observe(time.Now(), 80)
			}
			reports, stop := runRepeatingMonitor(m)
			defer stop()
			time.Sleep(2 * time.Minute)
			synctest.Wait()
			if len(reports) != 0 {
				t.Fatal("stale queued trigger started a capture")
			}
		})
	}
}
