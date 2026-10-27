// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	common_cache "github.com/boxlite-ai/common-go/pkg/cache"
)

// A navigation is anonymous presence, not a visitor identity or proof of guest rendering.
// This cooldown is independent of heartbeat polling and is set before delivery, even on failure.
func (p *Proxy) recordPreviewOpen(parent context.Context, boxID string) {
	p.previewOpenOnce.Do(func() { p.previewOpenCache = common_cache.NewMapCache[bool](context.Background()) })
	_, err, _ := p.previewOpenGroup.Do(boxID, func() (any, error) {
		ctx, cancel := context.WithTimeout(parent, 2*time.Second)
		defer cancel()
		seen, err := p.previewOpenCache.Has(ctx, boxID)
		if err != nil || seen {
			return nil, err
		}
		if err := p.previewOpenCache.Set(ctx, boxID, true, time.Minute); err != nil {
			return nil, err
		}
		configuration := p.apiclient.GetConfig()
		endpoint, err := url.JoinPath(configuration.Servers[0].URL, "box", boxID, "last-activity")
		if err != nil {
			return nil, err
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, nil)
		if err != nil {
			return nil, err
		}
		request.Header.Set("Authorization", configuration.DefaultHeader["Authorization"])
		request.Header.Set("X-BoxLite-Preview-Open", "1")
		client := configuration.HTTPClient
		if client == nil {
			client = http.DefaultClient
		}
		response, err := client.Do(request)
		if err != nil {
			return nil, err
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusCreated {
			return nil, fmt.Errorf("preview observation returned %d", response.StatusCode)
		}
		return nil, nil
	})
	if err != nil {
		slog.WarnContext(parent, "preview activity observation failed", "box", boxID)
	}
}
