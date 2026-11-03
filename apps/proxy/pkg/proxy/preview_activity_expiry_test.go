// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	common_cache "github.com/boxlite-ai/common-go/pkg/cache"
)

// The clock seam consumes the expiration passed by production code, not a test-built TTL.
type previewClockCache struct {
	now     time.Time
	ttl     time.Duration
	entries map[string]previewClockEntry
}

type previewClockEntry struct {
	value   bool
	expires time.Time
}

func (c *previewClockCache) Set(_ context.Context, key string, value bool, ttl time.Duration) error {
	if c.entries == nil {
		c.entries = make(map[string]previewClockEntry)
	}
	c.ttl = ttl
	c.entries[key] = previewClockEntry{value: value, expires: c.now.Add(ttl)}
	return nil
}
func (c *previewClockCache) Has(ctx context.Context, key string) (bool, error) {
	value, err := c.Get(ctx, key)
	return value != nil && *value, err
}
func (c *previewClockCache) Get(_ context.Context, key string) (*bool, error) {
	entry, ok := c.entries[key]
	if !ok || !c.now.Before(entry.expires) {
		return nil, nil
	}
	return &entry.value, nil
}
func (c *previewClockCache) Delete(_ context.Context, key string) error {
	delete(c.entries, key)
	return nil
}

func TestPreviewActivityReportsAgainAfterCooldown(t *testing.T) {
	proxy := newTunnelProxy(t, http.StatusOK)
	cache := &previewClockCache{now: time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)}
	proxy.previewOpenOnce.Do(func() { proxy.previewOpenCache = cache })
	calls := 0
	proxy.apiclient.GetConfig().HTTPClient = &http.Client{Transport: previewRoundTripper(func(_ *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: http.StatusCreated, Body: io.NopCloser(strings.NewReader(""))}, nil
	})}
	proxy.recordPreviewOpen(context.Background(), "AbCdEf123456")
	if cache.ttl != time.Minute {
		t.Fatalf("observation TTL = %s", cache.ttl)
	}
	cache.now = cache.now.Add(time.Minute - time.Nanosecond)
	proxy.recordPreviewOpen(context.Background(), "AbCdEf123456")
	if calls != 1 {
		t.Fatalf("delivered inside cooldown: %d", calls)
	}
	cache.now = cache.now.Add(time.Nanosecond)
	proxy.recordPreviewOpen(context.Background(), "AbCdEf123456")
	proxy.recordPreviewOpen(context.Background(), "AbCdEf123456")
	if calls != 2 {
		t.Fatalf("deliveries after expiry = %d, want 2", calls)
	}
}

func TestPreviewActivityCooldownIsPerBox(t *testing.T) {
	proxy := newTunnelProxy(t, http.StatusOK)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	proxy.previewOpenOnce.Do(func() { proxy.previewOpenCache = common_cache.NewMapCache[bool](ctx) })
	calls := make(map[string]int)
	proxy.apiclient.GetConfig().Servers[0].URL = "http://api.test"
	proxy.apiclient.GetConfig().HTTPClient = &http.Client{Transport: previewRoundTripper(func(request *http.Request) (*http.Response, error) {
		calls[request.URL.Path]++
		return &http.Response{StatusCode: http.StatusCreated, Body: io.NopCloser(strings.NewReader(""))}, nil
	})}
	boxIDs := []string{"AbCdEf123456", "ZyXwVu654321"}
	for range 3 {
		for _, boxID := range boxIDs {
			proxy.recordPreviewOpen(ctx, boxID)
		}
	}
	if len(calls) != 2 {
		t.Fatalf("observed box paths = %v, want 2", calls)
	}
	for _, boxID := range boxIDs {
		if got := calls["/box/"+boxID+"/last-activity"]; got != 1 {
			t.Fatalf("deliveries for %s = %d, want 1", boxID, got)
		}
	}
}
