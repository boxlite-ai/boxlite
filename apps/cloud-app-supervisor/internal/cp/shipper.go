package cp

import (
	"context"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/boxlite-ai/microcloud/supervisor/internal/api"
)

const (
	batchLines   = 200              // flush as soon as this many lines are pending
	batchEvery   = time.Second      // or at least this often
	maxPerPost   = 500              // the control plane keeps at most 500 lines per push
	maxPending   = 5000             // lines kept while the control plane is down
	minBackoff   = time.Second      // retry schedule after a failed POST
	maxBackoff   = 30 * time.Second //
	queueDepth   = 4096             // Emit → Run hand-off; overflow drops, never blocks
	flushTimeout = 10 * time.Second
)

// Shipper batches log lines to POST /sv/v1/logs. Emit is non-blocking by design:
// a service writing to stdout must never stall because the control plane is slow,
// so overflow is dropped rather than applying back-pressure. Dropped lines are
// counted and reported to the control plane as a system line once it accepts
// lines again.
type Shipper struct {
	cl       *Client
	in       chan api.LogLine
	dropped  atomic.Int64
	reported int64 // dropped count already announced; Run's goroutine only
	pending  ring
}

// NewShipper creates a shipper for cl. Call Run to start delivering.
func NewShipper(cl *Client) *Shipper {
	return &Shipper{cl: cl, in: make(chan api.LogLine, queueDepth), pending: newRing(maxPending)}
}

// Emit queues a line. It satisfies logs.Sink.
func (s *Shipper) Emit(l api.LogLine) {
	select {
	case s.in <- l:
	default:
		s.dropped.Add(1)
	}
}

// Dropped reports how many lines were discarded, because the hand-off queue
// was full or because the pending buffer overflowed during an outage.
func (s *Shipper) Dropped() int64 { return s.dropped.Load() }

// Run delivers batches until ctx is cancelled, then makes one final best-effort
// flush so a graceful shutdown does not lose the last second of output.
func (s *Shipper) Run(ctx context.Context) {
	ticker := time.NewTicker(batchEvery)
	defer ticker.Stop()
	backoff := minBackoff
	var retryAt time.Time

	for {
		select {
		case <-ctx.Done():
			s.drain()
			s.announceDrops()
			fctx, cancel := context.WithTimeout(context.Background(), flushTimeout)
			for s.pending.len() > 0 && s.flush(fctx) == nil {
			}
			cancel()
			return
		case l := <-s.in:
			s.enqueue(l)
			if s.pending.len() < batchLines || time.Now().Before(retryAt) {
				continue
			}
		case <-ticker.C:
			if time.Now().Before(retryAt) {
				continue
			}
			s.announceDrops()
			if s.pending.len() == 0 {
				continue
			}
		}
		if err := s.flush(ctx); err != nil {
			retryAt = time.Now().Add(backoff)
			backoff = min(backoff*2, maxBackoff)
			continue
		}
		backoff = minBackoff
	}
}

// announceDrops queues one system line saying how many lines were lost since
// the last announcement, so the gap is visible where the logs are read.
func (s *Shipper) announceDrops() {
	total := s.dropped.Load()
	if total == s.reported {
		return
	}
	n := total - s.reported
	s.reported = total
	s.enqueue(api.LogLine{
		TS: time.Now().UTC(), Source: api.SourceSystem, Level: api.LevelError,
		Line: fmt.Sprintf("log shipper dropped %d line(s) (queue full or control plane unreachable)", n),
	})
}

// enqueue keeps the newest lines: when the buffer is full the oldest is
// dropped, since the newest are the ones a failing deploy needs.
func (s *Shipper) enqueue(l api.LogLine) {
	if s.pending.push(l) {
		s.dropped.Add(1)
	}
}

func (s *Shipper) drain() {
	for {
		select {
		case l := <-s.in:
			s.enqueue(l)
		default:
			return
		}
	}
}

func (s *Shipper) flush(ctx context.Context) error {
	batch := s.pending.peek(maxPerPost)
	if err := s.cl.PostLogs(ctx, batch); err != nil {
		return err
	}
	s.pending.discard(len(batch))
	return nil
}

// ring is a fixed-capacity FIFO of pending lines. Pushing onto a full ring
// overwrites the oldest line in O(1).
type ring struct {
	buf   []api.LogLine
	start int
	n     int
}

func newRing(capacity int) ring { return ring{buf: make([]api.LogLine, capacity)} }

func (r *ring) len() int { return r.n }

// push appends l and reports whether the oldest line was overwritten.
func (r *ring) push(l api.LogLine) bool {
	if r.n < len(r.buf) {
		r.buf[(r.start+r.n)%len(r.buf)] = l
		r.n++
		return false
	}
	r.buf[r.start] = l
	r.start = (r.start + 1) % len(r.buf)
	return true
}

// peek copies out the oldest min(n, len) lines without removing them.
func (r *ring) peek(n int) []api.LogLine {
	n = min(n, r.n)
	out := make([]api.LogLine, n)
	for i := range out {
		out[i] = r.buf[(r.start+i)%len(r.buf)]
	}
	return out
}

// discard removes the oldest n lines.
func (r *ring) discard(n int) {
	n = min(n, r.n)
	for i := 0; i < n; i++ {
		r.buf[(r.start+i)%len(r.buf)] = api.LogLine{}
	}
	r.start = (r.start + n) % len(r.buf)
	r.n -= n
}
