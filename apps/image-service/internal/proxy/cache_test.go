// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"strconv"
	"testing"
	"time"
)

func TestTTLCacheForgetsAnEntryOnceItHasExpired(t *testing.T) {
	cache := newTTLCache[string](16)
	clock := time.Now()
	cache.now = func() time.Time { return clock }

	cache.put("key", "value", time.Minute)
	if got, held := cache.get("key"); !held || got != "value" {
		t.Fatalf("get = %q, %v; want the stored value", got, held)
	}

	clock = clock.Add(2 * time.Minute)
	if got, held := cache.get("key"); held {
		t.Errorf("get = %q after expiry, want nothing", got)
	}
}

func TestTTLCacheDeclinesAnEntryWithNoLifetime(t *testing.T) {
	cache := newTTLCache[string](16)
	cache.put("key", "value", 0)
	if _, held := cache.get("key"); held {
		t.Error("an entry with no lifetime was stored")
	}
}

// Both caches that reach this one are keyed on strings the caller supplies: a
// digest of whatever credential was presented, and an organization and
// repository read out of the request path. An unauthenticated caller adds a
// rejected credential on every request, and an authenticated one can name a new
// repository each time, so without a bound this is a way to exhaust the
// process's memory from outside.
func TestTTLCacheBoundsHowManyEntriesItHolds(t *testing.T) {
	const capacity = 32
	cache := newTTLCache[string](capacity)

	for i := range capacity * 10 {
		cache.put("key-"+strconv.Itoa(i), "value", time.Hour)
	}

	if held := cache.size(); held > capacity {
		t.Errorf("holding %d entries, want at most the cap of %d", held, capacity)
	}
}

// Room is made by forgetting what has expired, so the cap bounds how much is
// live at once rather than how much has ever been cached.
func TestTTLCacheMakesRoomByForgettingExpiredEntries(t *testing.T) {
	const capacity = 4
	cache := newTTLCache[string](capacity)
	clock := time.Now()
	cache.now = func() time.Time { return clock }

	for i := range capacity {
		cache.put("old-"+strconv.Itoa(i), "value", time.Minute)
	}
	clock = clock.Add(2 * time.Minute)

	cache.put("fresh", "value", time.Minute)
	if got, held := cache.get("fresh"); !held || got != "value" {
		t.Fatalf("get(fresh) = %q, %v; want the entry stored after the old ones expired", got, held)
	}
	if held := cache.size(); held != 1 {
		t.Errorf("holding %d entries, want only the fresh one", held)
	}
}
