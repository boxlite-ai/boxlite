// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"sync"
	"time"
)

// maxCacheEntries bounds each cache independently.
//
// It is a cap rather than a target: the caches hold what a fleet of runners and
// the repositories they pull add up to, which is far less. What the cap is for
// is the other case — a caller inventing keys — and 4096 is small enough that
// the worst case is a few hundred kilobytes.
const maxCacheEntries = 4096

// ttlCache holds values that stop being true after a while: an answer the
// control plane gave about a runner, a token an upstream issued.
//
// Two of the three key spaces that reach it are supplied by the caller — a
// digest of whatever credential was presented, and an organization and
// repository read out of the request path — so a caller can put a new key in on
// every request. That is why the cap and the sweep are here rather than at the
// call sites: without them this is a way to exhaust the process's memory from
// outside, and the unauthenticated half of it needs no credential at all.
//
// A full cache declines to store rather than evicting something live. Caching
// is an optimization, so refusing to cache costs a round trip; evicting a
// verified caller to make room for an invented key would cost correctness.
type ttlCache[V any] struct {
	capacity int
	now      func() time.Time

	mutex   sync.Mutex
	entries map[string]cacheEntry[V]
}

type cacheEntry[V any] struct {
	value   V
	expires time.Time
}

func newTTLCache[V any](capacity int) *ttlCache[V] {
	return &ttlCache[V]{capacity: capacity, now: time.Now, entries: map[string]cacheEntry[V]{}}
}

func (c *ttlCache[V]) get(key string) (V, bool) {
	c.mutex.Lock()
	defer c.mutex.Unlock()

	entry, held := c.entries[key]
	if !held {
		var zero V
		return zero, false
	}
	if !c.now().Before(entry.expires) {
		delete(c.entries, key)
		var zero V
		return zero, false
	}
	return entry.value, true
}

func (c *ttlCache[V]) put(key string, value V, lifetime time.Duration) {
	if lifetime <= 0 {
		return
	}
	c.mutex.Lock()
	defer c.mutex.Unlock()

	if _, replacing := c.entries[key]; !replacing && len(c.entries) >= c.capacity {
		c.sweepLocked()
		if len(c.entries) >= c.capacity {
			return
		}
	}
	c.entries[key] = cacheEntry[V]{value: value, expires: c.now().Add(lifetime)}
}

func (c *ttlCache[V]) size() int {
	c.mutex.Lock()
	defer c.mutex.Unlock()
	return len(c.entries)
}

// sweepLocked drops what has expired. Nothing else reclaims: an entry is only
// noticed as expired when its own key is looked up again, and a key invented
// once is never looked up twice.
func (c *ttlCache[V]) sweepLocked() {
	now := c.now()
	for key, entry := range c.entries {
		if !now.Before(entry.expires) {
			delete(c.entries, key)
		}
	}
}
