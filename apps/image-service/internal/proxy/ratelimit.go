// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// bucketIdleTTL is how long a meter outlives its last pull. Sweeping is what
// keeps the tracked set bounded, since one of the two things metered comes from
// the request path and a caller can name one that has never pulled before.
const bucketIdleTTL = 10 * time.Minute

// Scopes, so the two key spaces cannot collide in the one table: an
// organization named after a runner must not share that runner's meter.
const (
	runnerScope = "runner\x00"
	orgScope    = "org\x00"
)

// pullLimiter caps how fast pulls may arrive, metering two things.
//
// The runner is authenticated, so its meter is the one that actually bounds a
// caller: inventing organization names cannot buy more of it, and the set of
// runners is real rather than caller-chosen. The organization is what the
// platform accounts by, and is metered as well — but it arrives in the request
// path and nothing yet ties it to the caller, so on its own it would be a
// number a caller could choose.
//
// It counts requests, not bytes. A blob is a single long response, so byte
// volume follows from how many pulls run at once rather than how often they
// start; what this protects against is a loop asking for the same manifest
// thousands of times a second.
//
// The limit is per process. Several instances multiply it, which is the usual
// trade for not putting a shared store on the pull path.
type pullLimiter struct {
	limit rate.Limit
	burst int
	// capacity bounds the table. Past it, callers share overflow rather than
	// being refused: refusing whoever arrives after the table is full would let
	// one caller fill it and lock every other tenant out, which is a worse
	// failure than the crowding that sharing causes.
	capacity int

	mutex    sync.Mutex
	buckets  map[string]*meter
	overflow *rate.Limiter
	now      func() time.Time
}

type meter struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

func newPullLimiter(perSecond float64, burst, capacity int) *pullLimiter {
	limit := rate.Limit(perSecond)
	return &pullLimiter{
		limit:    limit,
		burst:    burst,
		capacity: capacity,
		buckets:  map[string]*meter{},
		overflow: rate.NewLimiter(limit, burst),
		now:      time.Now,
	}
}

// allow reports whether the pull may proceed, and if not, how long the caller
// should wait before asking again.
//
// Every meter is reserved together and all the reservations are cancelled when
// any of them says wait, so a pull that is refused is charged to none of them.
func (l *pullLimiter) allow(runner, org string) (time.Duration, bool) {
	now := l.now()
	meters := l.metersFor(runner, org, now)

	reservations := make([]*rate.Reservation, 0, len(meters))
	var wait time.Duration
	for _, meter := range meters {
		reservation := meter.ReserveN(now, 1)
		reservations = append(reservations, reservation)
		wait = max(wait, reservation.DelayFrom(now))
	}
	if wait > 0 {
		for _, reservation := range reservations {
			reservation.CancelAt(now)
		}
		return wait, false
	}
	return 0, true
}

// metersFor returns the distinct meters this pull is charged to.
//
// Distinct is the point: past the table's bound both scopes resolve to the
// shared meter, and a pull that costs one token everywhere else must not cost
// two there. The crowding overflow already causes should not also halve the
// rate it allows.
func (l *pullLimiter) metersFor(runner, org string, now time.Time) []*rate.Limiter {
	byRunner := l.meterFor(runnerScope+runner, now)
	byOrg := l.meterFor(orgScope+org, now)
	if byRunner == byOrg {
		return []*rate.Limiter{byRunner}
	}
	return []*rate.Limiter{byRunner, byOrg}
}

func (l *pullLimiter) meterFor(key string, now time.Time) *rate.Limiter {
	l.mutex.Lock()
	defer l.mutex.Unlock()

	if held, tracked := l.buckets[key]; tracked {
		held.lastSeen = now
		return held.limiter
	}
	if len(l.buckets) >= l.capacity {
		l.sweepLocked(now)
	}
	if len(l.buckets) >= l.capacity {
		return l.overflow
	}

	fresh := &meter{limiter: rate.NewLimiter(l.limit, l.burst), lastSeen: now}
	l.buckets[key] = fresh
	return fresh.limiter
}

func (l *pullLimiter) size() int {
	l.mutex.Lock()
	defer l.mutex.Unlock()
	return len(l.buckets)
}

func (l *pullLimiter) sweepLocked(now time.Time) {
	deadline := now.Add(-bucketIdleTTL)
	for key, held := range l.buckets {
		if held.lastSeen.Before(deadline) {
			delete(l.buckets, key)
		}
	}
}
