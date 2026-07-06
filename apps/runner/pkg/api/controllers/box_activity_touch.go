// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

package controllers

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	runnerapiclient "github.com/boxlite-ai/runner/pkg/apiclient"
)

const (
	boxActivityTouchInterval = 45 * time.Second
	boxActivityTouchTimeout  = 5 * time.Second
)

type updateBoxActivityFunc func(context.Context, string) error

var updateBoxLastActivity updateBoxActivityFunc = func(ctx context.Context, boxID string) error {
	apiClient, err := runnerapiclient.GetApiClient()
	if err != nil {
		return fmt.Errorf("get api client: %w", err)
	}

	resp, err := apiClient.BoxAPI.UpdateLastActivity(ctx, boxID).Execute()
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		return fmt.Errorf("update last activity for box %s: %w", boxID, err)
	}
	return nil
}

type boxActivityToucher struct {
	boxID       string
	minInterval time.Duration
	update      updateBoxActivityFunc
	logger      *slog.Logger

	mu          sync.Mutex
	lastTouchAt time.Time
}

func newBoxActivityToucher(boxID string, logger *slog.Logger) *boxActivityToucher {
	if logger == nil {
		logger = slog.Default()
	}
	return &boxActivityToucher{
		boxID:       boxID,
		minInterval: boxActivityTouchInterval,
		update:      updateBoxLastActivity,
		logger:      logger,
	}
}

func (t *boxActivityToucher) Touch(ctx context.Context) {
	if t == nil || t.boxID == "" {
		return
	}
	if ctx.Err() != nil {
		return
	}

	now := time.Now()
	t.mu.Lock()
	if !t.lastTouchAt.IsZero() && now.Sub(t.lastTouchAt) < t.minInterval {
		t.mu.Unlock()
		return
	}
	t.lastTouchAt = now
	t.mu.Unlock()

	go func() {
		touchCtx, cancel := context.WithTimeout(ctx, boxActivityTouchTimeout)
		defer cancel()

		if err := t.update(touchCtx, t.boxID); err != nil && touchCtx.Err() == nil {
			t.logger.WarnContext(touchCtx, "failed to update box activity", "box", t.boxID, "error", err)
		}
	}()
}
