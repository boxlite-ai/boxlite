// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

package executor

import (
	"errors"
	"sync"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

const (
	defaultJobCacheTTL      = 300 * time.Second
	defaultJobCacheCapacity = 1024
)

var ErrDirectCreateCapacity = errors.New("direct create job capacity reached")

type jobResult struct {
	status         apiclient.JobStatus
	resultMetadata any
	errorMessage   *string
}

type jobCacheEntry struct {
	done      bool
	result    *jobResult
	reported  bool
	expiresAt time.Time
}

type jobCache struct {
	mu       sync.Mutex
	entries  map[string]*jobCacheEntry
	ttl      time.Duration
	capacity int
	now      func() time.Time
}

func newJobCache(ttl time.Duration, capacity int, now func() time.Time) *jobCache {
	return &jobCache{entries: make(map[string]*jobCacheEntry), ttl: ttl, capacity: capacity, now: now}
}

func (c *jobCache) register(jobID string) (*jobCacheEntry, bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	for id, entry := range c.entries {
		if entry.done && !now.Before(entry.expiresAt) {
			delete(c.entries, id)
		}
	}
	if entry := c.entries[jobID]; entry != nil {
		return entry, false, nil
	}
	if len(c.entries) >= c.capacity {
		var oldestID string
		var oldest time.Time
		for id, entry := range c.entries {
			if entry.done && (oldestID == "" || entry.expiresAt.Before(oldest)) {
				oldestID = id
				oldest = entry.expiresAt
			}
		}
		if oldestID == "" {
			return nil, false, ErrDirectCreateCapacity
		}
		delete(c.entries, oldestID)
	}
	entry := &jobCacheEntry{expiresAt: now.Add(c.ttl)}
	c.entries[jobID] = entry
	return entry, true, nil
}

func (c *jobCache) complete(entry *jobCacheEntry, result *jobResult) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry.result = result
	entry.done = true
	entry.expiresAt = c.now().Add(c.ttl)
}

func (c *jobCache) markReported(entry *jobCacheEntry) {
	c.mu.Lock()
	entry.reported = true
	c.mu.Unlock()
}

func (c *jobCache) snapshot(entry *jobCacheEntry) (bool, *jobResult, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return entry.done, entry.result, entry.reported
}
