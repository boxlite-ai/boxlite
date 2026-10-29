// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

// Package cpumonitor attributes sustained host CPU saturation to box workloads.
package cpumonitor

import (
	"context"
	"log/slog"
	"math"
	"sync"
	"time"

	"github.com/google/uuid"
)

const (
	threshold       = 80.0
	sustained       = 5 * time.Minute
	captureDuration = 2 * time.Minute
	sampleInterval  = 5 * time.Second
)

type Box struct {
	ID, RuntimeID string
	Image         string
	PID           int
	StartedAt     time.Time
}

type Incident struct {
	EventID          string    `json:"eventId"`
	HighCPUSince     time.Time `json:"highCpuSince"`
	WindowStartedAt  time.Time `json:"windowStartedAt"`
	WindowEndedAt    time.Time `json:"windowEndedAt"`
	RunnerCPUPercent float64   `json:"runnerCpuPercent"`
	BoxID            *string   `json:"boxId"`
	Image            *string   `json:"image"`
	CPUSeconds       float64   `json:"cpuSeconds"`
	SamplingComplete bool      `json:"samplingComplete"`
}

type counter struct {
	identity string
	seconds  float64
	image    string
}

type Monitor struct {
	log             *slog.Logger
	interval        time.Duration
	mu              sync.Mutex
	last, highSince time.Time
	percent         float64
	triggers        chan struct{}
	reports         chan Incident
	sample          func(context.Context) (map[string]counter, bool)
	report          func(context.Context, Incident) (retry bool, err error)
}

func New(log *slog.Logger, interval time.Duration, list func(context.Context) ([]Box, error), report func(context.Context, Incident) (bool, error)) *Monitor {
	m := &Monitor{log: log, interval: interval, triggers: make(chan struct{}, 1), reports: make(chan Incident, 32), report: report}
	m.sample = func(ctx context.Context) (map[string]counter, bool) {
		boxes, err := list(ctx)
		if err != nil {
			log.WarnContext(ctx, "Failed to list boxes for CPU incident", "error", err)
			return nil, false
		}
		values, complete := make(map[string]counter), true
		for _, box := range boxes {
			if ctx.Err() != nil {
				return values, false
			}
			value, err := readCounter(ctx, box)
			if err != nil || box.ID == "" {
				complete = false
				continue
			}
			value.image = box.Image
			values[box.ID] = value
		}
		return values, complete
	}
	return m
}

// Observe is called only by the collector's sole host sampler. Slow box reads
// and uploads run elsewhere; a missed observation cannot extend continuity.
func (m *Monitor) Observe(now time.Time, percent float64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.last.IsZero() && (now.Sub(m.last) >= 2*m.interval || !now.After(m.last)) {
		m.highSince = time.Time{}
	}
	m.last = now
	m.percent = percent
	if math.IsNaN(percent) || math.IsInf(percent, 0) || percent < 0 || percent > 100 {
		m.highSince = time.Time{}
		return
	}
	if percent <= threshold {
		m.highSince = time.Time{}
		return
	}
	if m.highSince.IsZero() {
		m.highSince = now
	}
	if now.Sub(m.highSince) < sustained {
		return
	}
	select {
	case m.triggers <- struct{}{}:
	default:
	}
}

// A notification only wakes Run. Admission uses current continuity under the
// lock, so queued notifications cannot start windows after recovery or silence.
func (m *Monitor) nextIncident(now time.Time) (Incident, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.highSince.IsZero() || m.last.Sub(m.highSince) < sustained || now.Before(m.last) || now.Sub(m.last) >= 2*m.interval {
		return Incident{}, false
	}
	return Incident{HighCPUSince: m.highSince, RunnerCPUPercent: m.percent, SamplingComplete: true}, true
}

// Run owns capture and upload workers until ctx is cancelled.
func (m *Monitor) Run(ctx context.Context) {
	done := make(chan struct{})
	go func() { defer close(done); m.upload(ctx) }()
	defer func() { <-done }()
	for {
		if ctx.Err() != nil {
			return
		}
		event, ready := m.nextIncident(time.Now())
		if !ready {
			select {
			case <-ctx.Done():
				return
			case <-m.triggers:
			}
			continue
		}
		event.EventID = uuid.NewString()
		m.log.WarnContext(ctx, "Runner CPU sustained above threshold", "event", "runner.cpu.high", "eventId", event.EventID, "cpuPercent", event.RunnerCPUPercent, "threshold", threshold, "highCpuSince", event.HighCPUSince)
		event = m.capture(ctx, event)
		if ctx.Err() != nil {
			return
		}
		select {
		case m.reports <- event:
		default:
			m.log.ErrorContext(ctx, "CPU incident upload queue full; dropping newest report", "eventId", event.EventID)
		}
	}
}

type window struct {
	previous map[string]counter
	totals   map[string]float64
	images   map[string]string
	complete bool
}

func (w *window) add(values map[string]counter, complete bool) {
	w.complete = w.complete && complete
	if w.totals == nil {
		w.totals = make(map[string]float64)
		w.images = make(map[string]string)
	}
	for id, value := range values {
		w.images[id] = value.image
		old, exists := w.previous[id]
		if exists && old.identity == value.identity && value.seconds >= old.seconds {
			w.totals[id] += value.seconds - old.seconds
		} else if w.previous != nil {
			w.complete = false
		}
	}
	for id := range w.previous {
		if _, exists := values[id]; !exists {
			w.complete = false
		}
	}
	w.previous = values
}

func (w *window) finish(event Incident) Incident {
	event.SamplingComplete = w.complete
	for id, seconds := range w.totals {
		if seconds > event.CPUSeconds || (seconds > 0 && seconds == event.CPUSeconds && id < *event.BoxID) {
			id := id
			event.BoxID, event.CPUSeconds = &id, seconds
			image := w.images[id]
			event.Image = &image
		}
	}
	return event
}

func (m *Monitor) capture(ctx context.Context, event Incident) Incident {
	w := window{complete: true}
	sample := func() {
		bounded, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		values, complete := m.sample(bounded)
		w.add(values, complete)
	}
	event.WindowStartedAt = time.Now().UTC()
	sample()
	ticker := time.NewTicker(sampleInterval)
	defer ticker.Stop()
	deadline := time.NewTimer(time.Until(event.WindowStartedAt.Add(captureDuration)))
	defer deadline.Stop()
	for {
		select {
		case <-ctx.Done():
			return event
		case <-deadline.C:
			sample()
			event.WindowEndedAt = time.Now().UTC()
			return w.finish(event)
		case <-ticker.C:
			sample()
		}
	}
}

func (m *Monitor) upload(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case event := <-m.reports:
			for {
				bounded, cancel := context.WithTimeout(ctx, 10*time.Second)
				retry, err := m.report(bounded, event)
				cancel()
				if err == nil {
					break
				}
				m.log.ErrorContext(ctx, "Failed to upload CPU incident", "eventId", event.EventID, "retry", retry, "error", err)
				if !retry {
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
