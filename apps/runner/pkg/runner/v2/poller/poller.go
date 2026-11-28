/*
 * Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

package poller

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	runnerapiclient "github.com/boxlite-ai/runner/pkg/apiclient"
	"github.com/boxlite-ai/runner/pkg/runner/v2/executor"
)

type PollerServiceConfig struct {
	PollTimeout time.Duration
	PollLimit   int
	Logger      *slog.Logger
	Executor    *executor.Executor
}

// Service handles job polling from the API
type Service struct {
	log         *slog.Logger
	pollTimeout time.Duration
	pollLimit   int
	executor    *executor.Executor
	client      *apiclient.APIClient
}

// NewService creates a new poller service
func NewService(cfg *PollerServiceConfig) (*Service, error) {
	apiClient, err := runnerapiclient.GetApiClient()
	if err != nil {
		return nil, fmt.Errorf("failed to create API client: %w", err)
	}

	return &Service{
		log:         cfg.Logger.With(slog.String("component", "poller")),
		pollTimeout: cfg.PollTimeout,
		pollLimit:   cfg.PollLimit,
		executor:    cfg.Executor,
		client:      apiClient,
	}, nil
}

// Start runs until intake closes. The process context keeps admitted work and
// the last mutating poll alive while the runner drains.
func (s *Service) Start(ctx, intake context.Context) {
	defer s.log.InfoContext(ctx, "Job poller stopped")
	if intake.Err() != nil {
		return
	}
	inProgress, _, err := s.client.JobsAPI.ListJobs(intake).Status(apiclient.JOBSTATUS_IN_PROGRESS).Execute()
	if intake.Err() != nil {
		return
	}
	if err != nil {
		s.log.WarnContext(ctx, "Failed to fetch IN_PROGRESS jobs", "error", err)
	} else if inProgress != nil && len(inProgress.Items) > 0 {
		s.log.InfoContext(ctx, "Found IN_PROGRESS jobs", "count", len(inProgress.Items))
		for _, job := range inProgress.Items {
			go s.executor.Execute(ctx, &job)
		}
	} else {
		s.log.InfoContext(ctx, "No IN_PROGRESS jobs found")
	}

	s.log.InfoContext(ctx, "Starting job poller")
	for intake.Err() == nil {
		jobs, err := s.pollJobs(ctx)
		// Receiving the response orders the API's claim before our exit. A batch
		// returned after intake closed belongs to the next runner's startup scan.
		if intake.Err() != nil {
			if err != nil {
				s.log.WarnContext(ctx, "Final job poll failed during shutdown", "error", err)
			}
			return
		}
		if err != nil {
			s.log.ErrorContext(ctx, "Failed to poll jobs", "error", err)
			select {
			case <-intake.Done():
				return
			case <-time.After(5 * time.Second):
			}
			continue
		}
		if len(jobs) > 0 {
			s.log.DebugContext(ctx, "Received jobs", "count", len(jobs))
			for _, job := range jobs {
				go s.executor.Execute(ctx, &job)
			}
		}
	}
}

// pollJobs polls the API for pending jobs
func (s *Service) pollJobs(ctx context.Context) ([]apiclient.Job, error) {
	// Build poll request
	timeout := float32(s.pollTimeout.Seconds())
	limit := float32(s.pollLimit)

	req := s.client.JobsAPI.PollJobs(ctx).
		Timeout(timeout).
		Limit(limit)

	// Execute poll request
	resp, httpResp, err := req.Execute()
	if err != nil {
		// Check if it's a timeout (expected for long polling)
		if httpResp != nil && httpResp.StatusCode == 408 {
			// Timeout is normal for long polling, just return empty
			return []apiclient.Job{}, nil
		}
		return nil, err
	}

	if resp == nil {
		return []apiclient.Job{}, nil
	}

	return resp.GetJobs(), nil
}
