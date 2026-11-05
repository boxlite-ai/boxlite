// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

// Package memorymonitor reports immediate top-five Box memory snapshots.
package memorymonitor

import (
	"context"
	"log/slog"
	"math"
	"sort"
	"time"

	"github.com/google/uuid"
)

type Box struct {
	ID, RuntimeID, Image string
	PID                  int
}

type Usage struct {
	BoxID       string `json:"boxId"`
	Image       string `json:"image"`
	MemoryBytes uint64 `json:"memoryBytes,string"`
}

type Incident struct {
	EventID             string    `json:"eventId"`
	SampledAt           time.Time `json:"sampledAt"`
	RunnerMemoryPercent float64   `json:"runnerMemoryPercent"`
	Boxes               []Usage   `json:"boxes"`
	SamplingComplete    bool      `json:"samplingComplete"`
}

type Monitor struct {
	log     *slog.Logger
	list    func(context.Context) ([]Box, error)
	read    func(context.Context, Box) (uint64, error)
	report  func(context.Context, Incident) (bool, error)
	reports chan Incident
}

func New(log *slog.Logger, list func(context.Context) ([]Box, error), report func(context.Context, Incident) (bool, error)) *Monitor {
	return &Monitor{log: log, list: list, read: readMemory, report: report, reports: make(chan Incident, 32)}
}

// Observe runs once per minute on the resource sampler. Capture happens now;
// only completed reports are queued, so retries cannot delay attribution.
func (m *Monitor) Observe(ctx context.Context, now time.Time, percent float64) {
	if math.IsNaN(percent) || percent <= 80 || percent > 100 || ctx.Err() != nil {
		return
	}
	bounded, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	event := Incident{EventID: uuid.NewString(), SampledAt: now.UTC().Truncate(time.Millisecond), RunnerMemoryPercent: percent, Boxes: []Usage{}, SamplingComplete: true}
	boxes, err := m.list(bounded)
	if err != nil {
		m.log.WarnContext(ctx, "Failed to list boxes for memory incident", "error", err)
		event.SamplingComplete = false
		boxes = nil
	}
	seen := make(map[string]bool)
	for _, box := range boxes {
		if bounded.Err() != nil {
			event.SamplingComplete = false
			break
		}
		if box.ID == "" || seen[box.ID] {
			event.SamplingComplete = false
			continue
		}
		seen[box.ID] = true
		value, err := m.read(bounded, box)
		if bounded.Err() != nil {
			event.SamplingComplete = false
			break
		}
		if err != nil || value > math.MaxInt64 {
			event.SamplingComplete = false
			continue
		}
		event.Boxes = append(event.Boxes, Usage{BoxID: box.ID, Image: box.Image, MemoryBytes: value})
		sort.Slice(event.Boxes, func(i, j int) bool {
			a, b := event.Boxes[i], event.Boxes[j]
			if a.MemoryBytes != b.MemoryBytes {
				return a.MemoryBytes > b.MemoryBytes
			}
			return a.BoxID < b.BoxID
		})
		if len(event.Boxes) > 5 {
			event.Boxes = event.Boxes[:5]
		}
	}
	event.SamplingComplete = event.SamplingComplete && bounded.Err() == nil
	if ctx.Err() != nil {
		return
	}
	m.log.WarnContext(ctx, "Runner memory above threshold", "event", "runner.memory.high", "eventId", event.EventID, "memoryPercent", percent, "boxes", event.Boxes, "samplingComplete", event.SamplingComplete)
	select {
	case m.reports <- event:
	default:
		m.log.ErrorContext(ctx, "Memory incident upload queue full; dropping newest report", "eventId", event.EventID)
	}
}

// Run owns upload retries until cancellation; queued snapshots are immutable.
func (m *Monitor) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case event := <-m.reports:
			for {
				bounded, cancel := context.WithTimeout(ctx, 10*time.Second)
				retry, err := m.report(bounded, event)
				cancel()
				if err != nil {
					m.log.WarnContext(ctx, "Memory incident upload failed", "eventId", event.EventID, "error", err)
				}
				if !retry || ctx.Err() != nil {
					break
				}
				timer := time.NewTimer(30 * time.Second)
				select {
				case <-ctx.Done():
					timer.Stop()
					return
				case <-timer.C:
				}
			}
		}
	}
}
