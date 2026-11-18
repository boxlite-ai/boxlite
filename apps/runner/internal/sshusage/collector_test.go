// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0
package sshusage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/common-go/pkg/featureusage"
)

type source struct {
	listErr error
	boxes   []boxlite.BoxInfo
	take    func(context.Context, string) (*boxlite.SSHUsageBatch, error)
}

func (s source) ListInfo(context.Context) ([]boxlite.BoxInfo, error) {
	return append([]boxlite.BoxInfo(nil), s.boxes...), s.listErr
}
func (s source) TakeSSHUsage(ctx context.Context, id string) (*boxlite.SSHUsageBatch, error) {
	return s.take(ctx, id)
}
func logger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestPollPreservesGuestEvidenceAndCloudIdentity(t *testing.T) {
	var calls []string
	var got []featureusage.Event
	timestamp := time.Now().Add(-time.Minute).Truncate(time.Millisecond)
	c := New(source{
		boxes: []boxlite.BoxInfo{{ID: "native-id", Name: "CloudBox1234", Running: true}, {ID: "stopped", Name: "Stopped12345"}, {ID: "local", Name: "local-box", Running: true}},
		take: func(_ context.Context, id string) (*boxlite.SSHUsageBatch, error) {
			calls = append(calls, id)
			return &boxlite.SSHUsageBatch{Events: []boxlite.SSHUsageEvent{{ID: "source-uuid", OccurredAtMS: uint64(timestamp.UnixMilli())}}}, nil
		},
	}, func(event featureusage.Event) bool { got = append(got, event); return true }, logger())
	c.poll(context.Background())
	if len(calls) != 1 || calls[0] != "native-id" {
		t.Fatalf("unexpected native reads: %v", calls)
	}
	if len(got) != 1 || got[0].BoxID != "CloudBox1234" || got[0].ID != "source-uuid" || got[0].Kind != featureusage.SSH || !got[0].OccurredAt.Equal(timestamp) {
		t.Fatalf("source evidence changed: %#v", got)
	}
}

func TestPollBoundsWorkersAndRotatesAcrossBoxes(t *testing.T) {
	boxes := make([]boxlite.BoxInfo, 70)
	for i := range boxes {
		boxes[i] = boxlite.BoxInfo{ID: fmt.Sprintf("%03d", i), Name: fmt.Sprintf("Box%09d", i), Running: true}
	}
	var active, maxActive atomic.Int32
	var mu sync.Mutex
	seen := make(map[string]bool)
	c := New(source{boxes: boxes, take: func(ctx context.Context, id string) (*boxlite.SSHUsageBatch, error) {
		now := active.Add(1)
		for {
			old := maxActive.Load()
			if now <= old || maxActive.CompareAndSwap(old, now) {
				break
			}
		}
		defer active.Add(-1)
		time.Sleep(time.Millisecond)
		mu.Lock()
		seen[id] = true
		mu.Unlock()
		return &boxlite.SSHUsageBatch{}, nil
	}}, func(featureusage.Event) bool { return false }, logger())
	c.poll(context.Background())
	if len(seen) != maxBoxes {
		t.Fatalf("poll scanned %d boxes", len(seen))
	}
	c.poll(context.Background())
	if len(seen) != len(boxes) || maxActive.Load() > workers {
		t.Fatalf("seen=%d concurrency=%d", len(seen), maxActive.Load())
	}
}

func TestPollDeadlineShutdownAndFailures(t *testing.T) {
	entered := make(chan time.Duration, 1)
	c := New(source{boxes: []boxlite.BoxInfo{{ID: "native", Name: "CloudBox1234", Running: true}}, take: func(ctx context.Context, _ string) (*boxlite.SSHUsageBatch, error) {
		deadline, _ := ctx.Deadline()
		entered <- time.Until(deadline)
		<-ctx.Done()
		return nil, ctx.Err()
	}}, func(featureusage.Event) bool { t.Error("failed read produced evidence"); return false }, logger())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); c.Run(ctx) }()
	select {
	case budget := <-entered:
		if budget <= 0 || budget > time.Second {
			t.Errorf("read budget=%v", budget)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("collector never started a read")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("collector blocked shutdown")
	}
}

func TestPollRecoversAfterInventoryAndGuestFailures(t *testing.T) {
	var logs bytes.Buffer
	var events []featureusage.Event
	var batch *boxlite.SSHUsageBatch
	src := &source{
		listErr: errors.New("inventory offline"),
		boxes: []boxlite.BoxInfo{
			{ID: "native", Name: "CloudBox1234", Running: true},
			{ID: "other", Name: "CloudBox123!", Running: true},
		},
		take: func(_ context.Context, id string) (*boxlite.SSHUsageBatch, error) {
			if id != "native" {
				t.Errorf("drained unexpected box %q", id)
			}
			return batch, nil
		},
	}
	record := func(event featureusage.Event) bool {
		events = append(events, event)
		return true
	}
	c := New(src, record, slog.New(slog.NewTextHandler(&logs, nil)))
	poll := func() { c.poll(context.Background()) }
	poll()
	poll()
	src.listErr = nil
	poll()
	poll()
	batch = &boxlite.SSHUsageBatch{DroppedTotal: 2, Events: []boxlite.SSHUsageEvent{
		{ID: "invalid-time", OccurredAtMS: math.MaxUint64},
		{ID: "accepted", OccurredAtMS: 1234},
	}}
	poll()
	if len(events) != 1 || events[0].ID != "accepted" || events[0].OccurredAt.UnixMilli() != 1234 {
		t.Fatalf("recovered observations: %v", events)
	}
	batch.Events = nil
	poll()
	batch = nil
	poll()
	src.boxes[0].Running = false
	poll()
	src.boxes[0].Running = true
	poll()
	batch = &boxlite.SSHUsageBatch{DroppedTotal: 2}
	poll()
	for message, want := range map[string]int{
		"SSH usage listing unavailable":               1,
		"SSH usage unavailable":                       3,
		"Guest SSH usage buffer dropped observations": 2,
	} {
		if got := strings.Count(logs.String(), message); got != want {
			t.Errorf("%s: got %d warnings, want %d", message, got, want)
		}
	}
}
