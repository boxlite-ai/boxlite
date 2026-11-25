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

// Start begins the job polling loop
func (s *Service) Start(ctx context.Context) {
	jobs, err := s.listStartupJobs(ctx)
	if err != nil {
		return
	}
	if len(jobs) == 0 {
		s.log.InfoContext(ctx, "No IN_PROGRESS jobs found")
	} else {
		s.log.InfoContext(ctx, "Found IN_PROGRESS jobs", "count", len(jobs))
		for _, job := range jobs {
			go s.executor.Recover(ctx, &job)
		}
	}

	s.log.InfoContext(ctx, "Starting job poller")

	for {
		select {
		case <-ctx.Done():
			s.log.InfoContext(ctx, "Job poller stopped")
			return
		default:
			// Poll for jobs
			jobs, err := s.pollJobs(ctx)
			if err != nil {
				s.log.ErrorContext(ctx, "Failed to poll jobs", "error", err)
				// Wait a bit before retrying on error
				time.Sleep(5 * time.Second)
				continue
			}

			// Process jobs
			if len(jobs) > 0 {
				s.log.DebugContext(ctx, "Received jobs", "count", len(jobs))
				for _, job := range jobs {
					// Execute job in goroutine for parallel processing
					go s.executor.Execute(ctx, &job)
				}
			}
		}
	}
}

func (s *Service) listStartupJobs(ctx context.Context) ([]apiclient.Job, error) {
	// Complete the offset-paginated scan before job execution can shrink it.
	var jobs []apiclient.Job
	seen := make(map[string]struct{})
	for page := float32(1); ; page++ {
		result, err := s.listStartupPage(ctx, page)
		if err != nil {
			return nil, err
		}
		for _, job := range result.Items {
			if _, duplicate := seen[job.Id]; !duplicate {
				seen[job.Id] = struct{}{}
				jobs = append(jobs, job)
			}
		}
		if page >= result.TotalPages {
			return jobs, ctx.Err()
		}
	}
}

func (s *Service) listStartupPage(ctx context.Context, page float32) (*apiclient.PaginatedJobs, error) {
	const (
		pageSize       = 100
		requestTimeout = 30 * time.Second
		retryDelay     = time.Second
	)
	for ctx.Err() == nil {
		attempt, cancel := context.WithTimeout(ctx, requestTimeout)
		result, response, err := s.client.JobsAPI.ListJobs(attempt).
			Status(apiclient.JOBSTATUS_IN_PROGRESS).
			Page(page).
			Limit(pageSize).
			Execute()
		cancel()
		if err == nil && result != nil {
			return result, nil
		}
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		// List errors may contain job payloads. Log only safe metadata.
		s.log.WarnContext(ctx, "Failed to list startup jobs, retrying", "page", page, "http_status", status)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(retryDelay):
		}
	}
	return nil, ctx.Err()
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
