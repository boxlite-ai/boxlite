// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package boxlite

import (
	"sync"
	"testing"

	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
)

// evictBox drops a spent handle so the next lookup fetches a bootable one. It
// must drop only the handle it was handed: a concurrent Create or fetch can
// re-cache the same box id in between, and unmapping that winner would throw
// away a live entry the other caller is about to use.
//
// The handles here are zero-value wrappers used purely as identities — evictBox
// only compares and deletes map entries, so it never touches the FFI.
func TestEvictBoxRemovesOnlyTheHandleItWasGiven(t *testing.T) {
	stale := &boxlite.Box{}
	winner := &boxlite.Box{}

	t.Run("removes the stale handle", func(t *testing.T) {
		c := &Client{boxes: map[string]*boxlite.Box{"box-1": stale}}

		c.evictBox("box-1", stale)

		if _, ok := c.boxes["box-1"]; ok {
			t.Fatal("stale handle must be unmapped")
		}
	})

	t.Run("keeps a handle that replaced the stale one", func(t *testing.T) {
		c := &Client{boxes: map[string]*boxlite.Box{"box-1": winner}}

		c.evictBox("box-1", stale)

		if got := c.boxes["box-1"]; got != winner {
			t.Fatalf("the replacing handle must survive, got %v", got)
		}
	})

	t.Run("is a no-op for an id that is not cached", func(t *testing.T) {
		c := &Client{boxes: map[string]*boxlite.Box{}}

		c.evictBox("box-absent", stale)

		if len(c.boxes) != 0 {
			t.Fatalf("cache must stay empty, got %d entries", len(c.boxes))
		}
	})
}

// Concurrent eviction of the same entry must not race or double-delete; the
// mutex inside evictBox is what makes the read-modify-write safe.
func TestEvictBoxIsSafeUnderConcurrentCallers(t *testing.T) {
	stale := &boxlite.Box{}
	c := &Client{boxes: map[string]*boxlite.Box{"box-1": stale}}

	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.evictBox("box-1", stale)
		}()
	}
	wg.Wait()

	if _, ok := c.boxes["box-1"]; ok {
		t.Fatal("handle must be unmapped after concurrent eviction")
	}
}
