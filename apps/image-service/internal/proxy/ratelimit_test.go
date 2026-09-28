// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"strconv"
	"testing"
	"time"
)

// The burst has to clear a whole image: a manifest and its layers arrive as a
// few dozen requests at once, and a limit that stops mid-image would leave a
// half-pulled box.
func TestPullLimiterAllowsTheBurstThenAsksForAWait(t *testing.T) {
	limiter := newPullLimiter(1, 5, 16)

	for attempt := range 5 {
		if wait, allowed := limiter.allow("runner-a", "acme"); !allowed {
			t.Fatalf("pull %d refused with a %v wait, want the burst to clear", attempt+1, wait)
		}
	}

	wait, allowed := limiter.allow("runner-a", "acme")
	if allowed {
		t.Fatal("the sixth pull was allowed although the burst is five at one per second")
	}
	// The caller is told when to come back; a Retry-After of zero would invite
	// an immediate retry that is refused again.
	if wait <= 0 {
		t.Errorf("wait = %v, want a positive delay to report as Retry-After", wait)
	}
}

// Room is made by forgetting meters that went quiet, so the cap bounds
// concurrent use rather than lifetime use.
func TestPullLimiterForgetsMetersThatWentQuiet(t *testing.T) {
	limiter := newPullLimiter(1000, 1000, 4)
	clock := time.Now()
	limiter.now = func() time.Time { return clock }

	limiter.allow("runner-a", "first")
	limiter.allow("runner-a", "second")
	if tracked := limiter.size(); tracked != 3 {
		t.Fatalf("tracking %d meters, want one runner and two organizations", tracked)
	}

	clock = clock.Add(2 * bucketIdleTTL)
	limiter.allow("runner-b", "third")
	if tracked := limiter.size(); tracked != 2 {
		t.Errorf("tracking %d meters, want only the runner and organization still pulling", tracked)
	}
}

func TestPullLimiterMetersOrganizationsSeparately(t *testing.T) {
	limiter := newPullLimiter(1, 1, 16)

	if _, allowed := limiter.allow("runner-a", "acme"); !allowed {
		t.Fatal("acme's first pull was refused")
	}
	if _, allowed := limiter.allow("runner-a", "acme"); allowed {
		t.Fatal("acme's second pull was allowed past its burst of one")
	}
	if _, allowed := limiter.allow("runner-b", "globex"); !allowed {
		t.Error("globex was refused for acme's pulls")
	}
}

// Filling the tracked set must not lock anyone else out. The organization comes
// from the request path, so one caller can name as many as it likes; refusing
// whoever arrives after the table is full turns that into a denial aimed at
// every other tenant.
func TestPullLimiterDoesNotLockOutAnOrganizationWhenTheTableIsFull(t *testing.T) {
	limiter := newPullLimiter(1000, 1000, 4)

	for i := range 50 {
		limiter.allow("noisy-runner", "invented-"+strconv.Itoa(i))
	}
	if tracked := limiter.size(); tracked > 4 {
		t.Errorf("tracking %d buckets, want at most the cap of 4", tracked)
	}

	if wait, allowed := limiter.allow("quiet-runner", "a-tenant-that-just-arrived"); !allowed {
		t.Errorf("a new organization was refused for %v because the table was full", wait)
	}
}

// The organization is claimed, not proven; the runner is authenticated. Metering
// the runner is what actually bounds a caller, since inventing organization
// names cannot buy more of it.
func TestPullLimiterCapsARunnerHoweverManyOrganizationsItNames(t *testing.T) {
	limiter := newPullLimiter(1, 5, 1024)

	allowed := 0
	for i := range 50 {
		if _, ok := limiter.allow("one-runner", "org-"+strconv.Itoa(i)); ok {
			allowed++
		}
	}
	if allowed > 5 {
		t.Errorf("one runner got %d pulls past a burst of 5 by naming new organizations", allowed)
	}
}

// Both meters still apply: a runner under its own limit is still held to the
// organization's.
func TestPullLimiterStillMetersTheOrganization(t *testing.T) {
	limiter := newPullLimiter(1, 1, 1024)

	if _, allowed := limiter.allow("runner-a", "acme"); !allowed {
		t.Fatal("the first pull was refused")
	}
	if _, allowed := limiter.allow("runner-b", "acme"); allowed {
		t.Error("a second runner pulled for acme past its burst of one")
	}
}

// A refused pull must not be charged against either meter.
func TestPullLimiterChargesNeitherMeterForARefusal(t *testing.T) {
	limiter := newPullLimiter(1, 1, 1024)
	clock := time.Now()
	limiter.now = func() time.Time { return clock }

	if _, allowed := limiter.allow("runner-a", "acme"); !allowed {
		t.Fatal("the first pull was refused")
	}
	for range 20 {
		limiter.allow("runner-a", "acme")
	}

	clock = clock.Add(time.Second)
	if _, allowed := limiter.allow("runner-a", "acme"); !allowed {
		t.Error("a meter did not refill on schedule, so refusals were charged against it")
	}
}

// Past the table's bound both meters are the shared one, so a pull that would
// cost one token anywhere else must not cost two there — the crowding the
// overflow already causes should not also halve the rate it allows.
func TestPullLimiterChargesOneTokenPerPullWhenMetersAreShared(t *testing.T) {
	// Capacity zero puts every pull straight onto the shared meter.
	limiter := newPullLimiter(1, 6, 0)

	allowed := 0
	for range 10 {
		if _, ok := limiter.allow("one-runner", "acme"); ok {
			allowed++
		}
	}
	if allowed != 6 {
		t.Errorf("a burst of 6 admitted %d pulls, want 6 — each pull spent more than one token", allowed)
	}
}
