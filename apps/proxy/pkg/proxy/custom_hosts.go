// Copyright 2025 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// customHosts routes a host name that is not a tunnel name (a customer's own
// domain pointed at the proxy) to a Box port, by asking the service that owns
// the domain (CUSTOM_HOST_RESOLVER_URL). It only names a Box and a port: the
// request then passes the same gates as the tunnel URL of that port, so a
// mapped host reaches nothing its tunnel URL could not. Unset, nothing changes.
type customHosts struct {
	url    string
	token  string
	client *http.Client
	ttl    time.Duration

	mu    sync.Mutex
	cache map[string]customHostEntry
}

type customHostEntry struct {
	port    uint16
	boxID   string
	found   bool
	expires time.Time
}

// errNotCustomHost: the resolver does not route this host.
var errNotCustomHost = errors.New("not a known host")

func newCustomHosts(resolverURL, token string) *customHosts {
	if resolverURL == "" {
		return nil
	}
	return &customHosts{url: resolverURL, token: token, client: &http.Client{Timeout: 3 * time.Second}, ttl: 60 * time.Second, cache: map[string]customHostEntry{}}
}

// resolve answers from the cache (hits and misses alike) or asks the resolver:
// GET <url>?host=<host> → 200 {"box_id": "...", "port": 3000}, 404 when unknown.
func (c *customHosts) resolve(ctx context.Context, host string) (uint16, string, error) {
	host = strings.ToLower(strings.TrimSuffix(strings.Split(host, ":")[0], "."))
	c.mu.Lock()
	e, ok := c.cache[host]
	c.mu.Unlock()
	if ok && time.Now().Before(e.expires) {
		if !e.found {
			return 0, "", errNotCustomHost
		}
		return e.port, e.boxID, nil
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.url+"?host="+url.QueryEscape(host), nil)
	if err != nil {
		return 0, "", err
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	res, err := c.client.Do(req)
	if err != nil {
		return 0, "", fmt.Errorf("custom host resolver: %w", err)
	}
	defer res.Body.Close()

	entry := customHostEntry{expires: time.Now().Add(c.ttl)}
	switch res.StatusCode {
	case http.StatusOK:
		var body struct {
			BoxID string `json:"box_id"`
			Port  int    `json:"port"`
		}
		if err := json.NewDecoder(res.Body).Decode(&body); err != nil || body.BoxID == "" || body.Port < 1 || body.Port > 65535 {
			return 0, "", fmt.Errorf("custom host resolver: bad answer for %s", host)
		}
		entry.found, entry.port, entry.boxID = true, uint16(body.Port), body.BoxID
	case http.StatusNotFound:
	default:
		// Not cached: a resolver hiccup must not stick for a minute.
		return 0, "", fmt.Errorf("custom host resolver: HTTP %d for %s", res.StatusCode, host)
	}
	c.mu.Lock()
	c.cache[host] = entry
	c.mu.Unlock()
	if !entry.found {
		return 0, "", errNotCustomHost
	}
	return entry.port, entry.boxID, nil
}
