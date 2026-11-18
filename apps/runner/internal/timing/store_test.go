// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

package timing

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

func resetHistory(t *testing.T) {
	t.Helper()
	resetForTest()
	t.Cleanup(resetForTest)
	t.Cleanup(SetWriterForTest(nil))
}

func TestSnapshotFiltersAndKeepsNewestEvents(t *testing.T) {
	resetHistory(t)
	const count = 280
	for i := range count {
		Emit("exec", "exec.started", OK, time.Now(), IDs{BoxID: "selected", ExecID: fmt.Sprint(i)})
		Emit("create", "create.received", OK, time.Now(), IDs{BoxID: "other"})
	}
	Emit("exec", "exec.request", Error, time.Now(), IDs{})

	got := Snapshot("selected")
	if len(got) != 256 {
		t.Fatalf("got %d events, want 256", len(got))
	}
	for i, e := range got {
		if e.BoxID != "selected" || e.ExecID != fmt.Sprint(count-256+i) {
			t.Fatalf("event %d is not the expected event in insertion order: %+v", i, e)
		}
		if _, err := time.Parse(time.RFC3339Nano, e.TS); err != nil {
			t.Fatalf("event %d timestamp: %v", i, err)
		}
	}
	got[0].ExecID = "changed"
	if again := Snapshot("selected"); again[0].ExecID != "24" {
		t.Fatalf("snapshot aliases storage: %+v", again[0])
	}
	for _, id := range []string{"missing", ""} {
		if got := Snapshot(id); got == nil || len(got) != 0 {
			t.Fatalf("Snapshot(%q) = %#v, want non-nil empty slice", id, got)
		}
	}
}

func TestSnapshotEvictsLeastRecentlyUpdatedBox(t *testing.T) {
	resetHistory(t)
	for i := range 1024 {
		Emit("exec", "exec.started", OK, time.Now(), IDs{BoxID: fmt.Sprint(i)})
	}
	Emit("exec", "exec.started", OK, time.Now(), IDs{BoxID: "0"})
	_ = Snapshot("1") // reading does not count as an update
	Emit("exec", "exec.started", OK, time.Now(), IDs{BoxID: "1024"})
	if a, b, c := len(Snapshot("0")), len(Snapshot("1")), len(Snapshot("1024")); a != 2 || b != 0 || c != 1 {
		t.Fatalf("oldest updated, evicted, new box counts = %d, %d, %d; want 2, 0, 1", a, b, c)
	}
}

func TestConcurrentEmitAndSnapshot(t *testing.T) {
	resetHistory(t)
	const workers, iterations = 16, 100
	check := func(events []Event) {
		t.Helper()
		if len(events) > 256 {
			t.Errorf("snapshot exceeds capacity: %d", len(events))
		}
		seen := make(map[string]bool)
		for _, e := range events {
			if e.BoxID != "shared" || e.Op != "exec" || e.Stage != "exec.started" || e.JobID == "" || e.JobID != e.ExecID || e.Status != OK || e.TS == "" || seen[e.ExecID] {
				t.Errorf("torn or duplicate event: %+v", e)
			}
			seen[e.ExecID] = true
		}
	}
	var wg sync.WaitGroup
	ready := make(chan struct{})
	for i := range workers {
		wg.Go(func() {
			<-ready
			for j := range iterations {
				id := fmt.Sprintf("%d-%d", i, j)
				Emit("exec", "exec.started", OK, time.Now(), IDs{BoxID: "shared", JobID: id, ExecID: id})
			}
		})
	}
	close(ready)
	for range iterations {
		check(Snapshot("shared"))
	}
	wg.Wait()
	got := Snapshot("shared")
	if len(got) == 0 {
		t.Fatal("no concurrent events were retained")
	}
	check(got)
}

func TestEmitDoesNotWaitForHistoryLock(t *testing.T) {
	resetHistory(t)
	finished := make(chan struct{})
	history.mu.Lock()
	go func() {
		Emit("exec", "exec.started", OK, time.Now(), IDs{BoxID: "contended"})
		close(finished)
	}()
	select {
	case <-finished:
		history.mu.Unlock()
	case <-time.After(2 * time.Second):
		history.mu.Unlock()
		<-finished
		t.Fatal("Emit waited for the history lock")
	}
	if got := Snapshot("contended"); len(got) != 0 {
		t.Fatalf("contended append unexpectedly stored %d events", len(got))
	}
}
