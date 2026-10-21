package cp

import (
	"context"
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
// so overflow is counted and dropped rather than applying back-pressure.
type Shipper struct {
	cl      *Client
	in      chan api.LogLine
	dropped atomic.Int64
	pending []api.LogLine
}

// NewShipper creates a shipper for cl. Call Run to start delivering.
func NewShipper(cl *Client) *Shipper {
	return &Shipper{cl: cl, in: make(chan api.LogLine, queueDepth)}
}

// Emit queues a line. It satisfies logs.Sink.
func (s *Shipper) Emit(l api.LogLine) {
	select {
	case s.in <- l:
	default:
		s.dropped.Add(1)
	}
}

// Dropped reports how many lines were discarded because the queue was full.
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
			fctx, cancel := context.WithTimeout(context.Background(), flushTimeout)
			for len(s.pending) > 0 && s.flush(fctx) == nil {
			}
			cancel()
			return
		case l := <-s.in:
			s.enqueue(l)
			if len(s.pending) < batchLines || time.Now().Before(retryAt) {
				continue
			}
		case <-ticker.C:
			if len(s.pending) == 0 || time.Now().Before(retryAt) {
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

func (s *Shipper) enqueue(l api.LogLine) {
	if len(s.pending) >= maxPending {
		// Keep the newest lines: they are the ones a failing deploy needs.
		copy(s.pending, s.pending[1:])
		s.pending = s.pending[:len(s.pending)-1]
		s.dropped.Add(1)
	}
	s.pending = append(s.pending, l)
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
	n := min(len(s.pending), maxPerPost)
	batch := s.pending[:n]
	if err := s.cl.PostLogs(ctx, batch); err != nil {
		return err
	}
	s.pending = append(s.pending[:0], s.pending[n:]...)
	return nil
}
