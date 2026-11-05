package memorymonitor

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"reflect"
	"testing"
	"testing/synctest"
	"time"
)

func testMonitor(boxes []Box) *Monitor {
	return New(slog.New(slog.NewTextHandler(io.Discard, nil)), func(context.Context) ([]Box, error) { return boxes, nil }, nil)
}

func TestMemoryIncidentImmediateTopFiveAndThreshold(t *testing.T) {
	m := testMonitor([]Box{{ID: "zero"}, {ID: "b"}, {ID: "a", Image: "image:a"}, {ID: "c"}, {ID: "d"}, {ID: "e"}, {ID: "f"}})
	reads := 0
	m.read = func(_ context.Context, box Box) (uint64, error) {
		reads++
		return map[string]uint64{"zero": 0, "a": 9007199254740993, "b": 9007199254740993, "c": 30, "d": 20, "e": 10, "f": 1}[box.ID], nil
	}
	now := time.Now().Truncate(time.Millisecond)
	for _, percent := range []float64{0, 80, -1, 101, math.NaN(), math.Inf(1), math.Inf(-1)} {
		m.Observe(context.Background(), now, percent)
	}
	if reads != 0 || len(m.reports) != 0 {
		t.Fatal("scanned below threshold or on invalid sample")
	}
	var previousID string
	for i := 0; i < 2; i++ {
		m.Observe(context.Background(), now.Add(time.Duration(i)*time.Minute), 80.000001)
		select {
		case report := <-m.reports:
			var ids []string
			for _, box := range report.Boxes {
				ids = append(ids, box.BoxID)
			}
			if !reflect.DeepEqual(ids, []string{"a", "b", "c", "d", "e"}) || !report.SamplingComplete || report.EventID == previousID || report.EventID == "" {
				t.Fatalf("wrong report: %+v", report)
			}
			if !report.SampledAt.Equal(now.Add(time.Duration(i) * time.Minute)) {
				t.Fatal("incorrect host sample time")
			}
			body, err := json.Marshal(report)
			if err != nil {
				t.Fatal(err)
			}
			var decoded struct {
				Boxes []struct {
					MemoryBytes string
					Image       string
				}
			}
			if err := json.Unmarshal(body, &decoded); err != nil {
				t.Fatal(err)
			}
			if decoded.Boxes[0].MemoryBytes != "9007199254740993" || decoded.Boxes[0].Image != "image:a" {
				t.Fatalf("lost bytes/image: %s", body)
			}
			previousID = report.EventID
		default:
			t.Fatal("did not report immediately")
		}
		m.Observe(context.Background(), now, 80)
	}
}

func TestMemoryIncidentPartialEmptyAndZeroReadings(t *testing.T) {
	m := testMonitor([]Box{{ID: "gone"}, {ID: "a"}, {ID: "overflow"}, {ID: "a"}, {}})
	m.read = func(_ context.Context, box Box) (uint64, error) {
		if box.ID == "gone" {
			return 0, errors.New("exited")
		}
		if box.ID == "overflow" {
			return math.MaxUint64, nil
		}
		return 0, nil
	}
	m.Observe(context.Background(), time.Now(), 90)
	event := <-m.reports
	if event.SamplingComplete || len(event.Boxes) != 1 || event.Boxes[0].BoxID != "a" || event.Boxes[0].MemoryBytes != 0 {
		t.Fatalf("wrong partial result: %+v", event)
	}
	for _, fail := range []bool{false, true} {
		m.list = func(context.Context) ([]Box, error) {
			if fail {
				return nil, errors.New("list failed")
			}
			return nil, nil
		}
		m.Observe(context.Background(), time.Now(), 90)
		event := <-m.reports
		if event.Boxes == nil || len(event.Boxes) != 0 || event.SamplingComplete == fail {
			t.Fatalf("wrong empty result: %+v", event)
		}
	}
}

func TestMemoryIncidentQueueBoundsAndCancellation(t *testing.T) {
	m := testMonitor(nil)
	start := time.Unix(1700000000, 0)
	for i := 0; i < 33; i++ {
		m.Observe(context.Background(), start.Add(time.Duration(i)*time.Minute), 90)
	}
	if len(m.reports) != 32 {
		t.Fatal("unbounded report queue")
	}
	first := <-m.reports
	if first.EventID == "" || !first.SampledAt.Equal(start) {
		t.Fatal("dropped oldest instead of newest")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	m.Observe(ctx, time.Now(), 90)
	if len(m.reports) != 31 {
		t.Fatal("reported after cancellation")
	}
}

func TestMemoryIncidentRetriesDoNotBlockNextSnapshot(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		m := testMonitor(nil)
		var uploads []Incident
		m.report = func(_ context.Context, event Incident) (bool, error) {
			uploads = append(uploads, event)
			if len(uploads) <= 4 {
				return true, errors.New("retry")
			}
			return false, nil
		}
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() { defer close(done); m.Run(ctx) }()
		m.Observe(ctx, time.Now(), 90)
		synctest.Wait()
		time.Sleep(time.Minute)
		synctest.Wait()
		m.Observe(ctx, time.Now(), 91)
		synctest.Wait()
		if len(m.reports) != 1 {
			t.Fatal("next minute was blocked by upload retries")
		}
		time.Sleep(time.Minute)
		synctest.Wait()
		if len(uploads) != 6 || uploads[5].EventID == uploads[0].EventID {
			t.Fatalf("incorrect retries: %+v", uploads)
		}
		for _, retry := range uploads[1:5] {
			if !reflect.DeepEqual(uploads[0], retry) {
				t.Fatal("retry mutated snapshot")
			}
		}
		cancel()
		<-done
	})
}

func TestMemoryIncidentScanDeadlineKeepsEarlierObservations(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		m := testMonitor([]Box{{ID: "a"}, {ID: "slow"}})
		m.read = func(ctx context.Context, box Box) (uint64, error) {
			if box.ID == "slow" {
				<-ctx.Done()
				return 0, ctx.Err()
			}
			return 100, nil
		}
		m.Observe(context.Background(), time.Now(), 90)
		event := <-m.reports
		if event.SamplingComplete || len(event.Boxes) != 1 || event.Boxes[0].BoxID != "a" {
			t.Fatalf("lost partial snapshot: %+v", event)
		}
		m.list = func(ctx context.Context) ([]Box, error) {
			<-ctx.Done()
			return nil, nil
		}
		m.Observe(context.Background(), time.Now(), 90)
		if event := <-m.reports; event.SamplingComplete || len(event.Boxes) != 0 {
			t.Fatalf("late empty enumeration reported complete: %+v", event)
		}
	})
}

func TestMemoryIncidentCancelsRetryWait(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		m := testMonitor(nil)
		m.report = func(context.Context, Incident) (bool, error) { return true, errors.New("offline") }
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() { defer close(done); m.Run(ctx) }()
		m.Observe(ctx, time.Now(), 90)
		synctest.Wait()
		cancel()
		<-done
	})
}
