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
)

// The clock seam consumes the expiration passed by production code, not a test-built TTL.
type previewClockCache struct {
	now, expires time.Time
	ttl          time.Duration
	value        bool
}

func (c *previewClockCache) Set(_ context.Context, _ string, value bool, ttl time.Duration) error {
	c.value, c.ttl, c.expires = value, ttl, c.now.Add(ttl)
	return nil
}
func (c *previewClockCache) Has(context.Context, string) (bool, error) {
	return c.value && c.now.Before(c.expires), nil
}
func (c *previewClockCache) Get(context.Context, string) (*bool, error) { return &c.value, nil }
func (c *previewClockCache) Delete(context.Context, string) error       { c.value = false; return nil }

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
