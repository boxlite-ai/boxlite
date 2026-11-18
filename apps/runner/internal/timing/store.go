// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

package timing

import (
	"container/list"
	"sync"
	"time"
)

const (
	eventsPerBox = 256
	maxBoxes     = 1024
)

type boxHistory struct {
	id     string
	events [eventsPerBox]Event
	next   int
	count  int
}

var history = eventStore{boxes: make(map[string]*list.Element)}

type eventStore struct {
	mu    sync.Mutex
	boxes map[string]*list.Element
	order list.List // most recently appended to first; reads do not affect eviction
}

func (s *eventStore) append(e *Event) {
	defer func() { _ = recover() }() // A probe must not fail its caller.
	if !s.mu.TryLock() {
		return
	}
	defer s.mu.Unlock()

	entry := s.boxes[e.BoxID]
	if entry == nil {
		if len(s.boxes) == maxBoxes {
			oldest := s.order.Back()
			delete(s.boxes, oldest.Value.(*boxHistory).id)
			s.order.Remove(oldest)
		}
		entry = s.order.PushFront(&boxHistory{id: e.BoxID})
		s.boxes[e.BoxID] = entry
	} else {
		s.order.MoveToFront(entry)
	}
	box := entry.Value.(*boxHistory)
	e.TS = time.Now().UTC().Format(time.RFC3339Nano)
	box.events[box.next] = *e
	box.next = (box.next + 1) % eventsPerBox
	box.count = min(box.count+1, eventsPerBox)
}

// Snapshot returns a detached copy in oldest-to-newest observation order.
// Unknown box IDs return a non-nil empty slice.
func Snapshot(boxID string) []Event {
	history.mu.Lock()
	defer history.mu.Unlock()
	entry := history.boxes[boxID]
	if entry == nil {
		return []Event{}
	}
	box := entry.Value.(*boxHistory)
	events := make([]Event, box.count)
	oldest := (box.next + eventsPerBox - box.count) % eventsPerBox
	n := copy(events, box.events[oldest:])
	copy(events[n:], box.events[:box.next])
	return events
}

func resetForTest() {
	history.mu.Lock()
	defer history.mu.Unlock()
	clear(history.boxes)
	history.order.Init()
}
