// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package cpumonitor

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

func NewReporter(baseURL, token string, client *http.Client) (func(context.Context, Incident) (bool, error), error) {
	base, err := url.Parse(baseURL)
	if err != nil || base == nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return nil, fmt.Errorf("invalid CPU incident API base URL")
	}
	endpoint := strings.TrimRight(base.String(), "/") + "/runners/me/cpu-incidents"
	return func(ctx context.Context, event Incident) (bool, error) {
		body, err := json.Marshal(event)
		if err != nil {
			return false, err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
		if err != nil {
			return false, err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-BoxLite-Source", "runner")
		res, err := client.Do(req)
		if err != nil {
			return true, err
		}
		defer res.Body.Close()
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
		if res.StatusCode >= 200 && res.StatusCode < 300 {
			return false, nil
		}
		return res.StatusCode == 429 || res.StatusCode >= 500, fmt.Errorf("CPU incident API returned HTTP %d", res.StatusCode)
	}, nil
}
