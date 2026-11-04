// Package logs keeps the per-source ring buffers that back GET /.boxlite/sv/logs
// and fans every line out to sinks such as the control-plane shipper. Emitting a
// line never blocks: the ring is a fixed array and sinks are required to be
// non-blocking, so a slow or dead control plane cannot stall a service's stdout.
package logs

import (
	"fmt"
	"log"
	"sort"
	"sync"
	"time"

	"github.com/boxlite-ai/microcloud/supervisor/internal/api"
)

// RingSize is the number of lines kept per source (contracts.md 2.4).
const RingSize = 2000

// Ring is a fixed-capacity FIFO of log lines.
type Ring struct {
	mu    sync.Mutex
	buf   []api.LogLine
	start int // index of the oldest line
	n     int
}

// NewRing returns an empty ring holding at most capacity lines.
func NewRing(capacity int) *Ring {
	if capacity <= 0 {
		capacity = RingSize
	}
	return &Ring{buf: make([]api.LogLine, capacity)}
}

// Append adds a line, evicting the oldest when full.
func (r *Ring) Append(l api.LogLine) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.n < len(r.buf) {
		r.buf[(r.start+r.n)%len(r.buf)] = l
		r.n++
		return
	}
	r.buf[r.start] = l
	r.start = (r.start + 1) % len(r.buf)
}

// Tail returns the newest n lines, oldest first. n <= 0 returns everything.
func (r *Ring) Tail(n int) []api.LogLine {
	r.mu.Lock()
	defer r.mu.Unlock()
	if n <= 0 || n > r.n {
		n = r.n
	}
	out := make([]api.LogLine, n)
	first := r.n - n
	for i := 0; i < n; i++ {
		out[i] = r.buf[(r.start+first+i)%len(r.buf)]
	}
	return out
}

// Sink receives every line emitted through a Hub. Implementations must not block.
type Sink func(api.LogLine)

// Hub owns one ring per source and the list of sinks.
type Hub struct {
	mu    sync.Mutex
	rings map[string]*Ring
	sinks []Sink
}

// NewHub creates a hub that forwards every line to the given sinks.
func NewHub(sinks ...Sink) *Hub {
	return &Hub{rings: map[string]*Ring{}, sinks: sinks}
}

// Emit records a line in its source's ring and forwards it to the sinks.
func (h *Hub) Emit(l api.LogLine) {
	if l.TS.IsZero() {
		l.TS = time.Now().UTC()
	}
	if l.Level == "" {
		l.Level = api.LevelInfo
	}
	h.mu.Lock()
	ring, ok := h.rings[l.Source]
	if !ok {
		ring = NewRing(RingSize)
		h.rings[l.Source] = ring
	}
	sinks := h.sinks
	h.mu.Unlock()
	ring.Append(l)
	for _, s := range sinks {
		s(l)
	}
}

// Tail returns the newest n lines of one source, or of every source merged by
// timestamp when source is empty.
func (h *Hub) Tail(source string, n int) []api.LogLine {
	h.mu.Lock()
	var rings []*Ring
	if source != "" {
		if r, ok := h.rings[source]; ok {
			rings = append(rings, r)
		}
	} else {
		for _, r := range h.rings {
			rings = append(rings, r)
		}
	}
	h.mu.Unlock()

	var all []api.LogLine
	for _, r := range rings {
		all = append(all, r.Tail(n)...)
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].TS.Before(all[j].TS) })
	if n > 0 && len(all) > n {
		all = all[len(all)-n:]
	}
	if all == nil {
		all = []api.LogLine{}
	}
	return all
}

// Systemf emits a `source: "system"` line and mirrors it to the supervisor's own
// stderr so the Box console shows the same story the control plane sees.
func (h *Hub) Systemf(deployment int, level, format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	log.Printf("[system] %s", msg)
	h.Emit(api.LogLine{Source: api.SourceSystem, Level: level, Line: msg, Deployment: deployment})
}

// Lines flattens log lines into plain strings for a status log_tail.
func Lines(ls []api.LogLine) []string {
	out := make([]string, 0, len(ls))
	for _, l := range ls {
		out = append(out, l.Line)
	}
	return out
}
