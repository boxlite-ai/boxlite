// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package proxy

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

func (p *Proxy) hasPublicTunnelAccess(ctx context.Context, boxID string, port uint16) (bool, error) {
	configuration := p.apiclient.GetConfig()
	endpoint, err := url.JoinPath(configuration.Servers[0].URL, "preview", boxID, "tunnels", strconv.Itoa(int(port)))
	if err != nil {
		return false, fmt.Errorf("build tunnel access endpoint: %w", err)
	}
	checkCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(checkCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return false, fmt.Errorf("build tunnel access request: %w", err)
	}
	request.Header.Set("Authorization", configuration.DefaultHeader["Authorization"])
	client := configuration.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		return false, fmt.Errorf("check tunnel access for box %s port %d: %w", boxID, port, err)
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusOK:
		return true, nil
	case http.StatusNotFound:
		return false, nil
	default:
		return false, fmt.Errorf("check tunnel access for box %s port %d: API returned %d", boxID, port, response.StatusCode)
	}
}
