/*
 * Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

package poller

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
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
	ids, err := s.listStartupJobs(ctx)
	if err != nil {
		return
	}
	for _, id := range ids {
		job, err := readStartup(ctx, s.log, func(attempt context.Context) (*apiclient.Job, *http.Response, error) {
			job, response, err := s.client.JobsAPI.GetJob(attempt, id).Execute()
			if response != nil && response.StatusCode == http.StatusNotFound {
				return nil, response, nil
			}
			if err == nil && (job == nil || job.Id != id) {
				return nil, response, fmt.Errorf("invalid startup job response")
			}
			return job, response, err
		})
		if err != nil {
			return
		}
		if job != nil && job.Status == apiclient.JOBSTATUS_IN_PROGRESS {
			go s.executor.Recover(ctx, job)
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

func (s *Service) listStartupJobs(ctx context.Context) ([]string, error) {
	const pageSize = 100
	cursor := "00000000-0000-0000-0000-000000000000"
	var ids []string
	for {
		page, err := readStartup(ctx, s.log, func(attempt context.Context) (*apiclient.PaginatedJobs, *http.Response, error) {
			page, response, err := s.client.JobsAPI.ListJobs(attempt).
				Status(apiclient.JOBSTATUS_IN_PROGRESS).AfterId(cursor).Limit(pageSize).Execute()
			if err == nil && page == nil {
				return nil, response, fmt.Errorf("empty startup job page")
			}
			if err == nil {
				// An older API may ignore the cursor. Never dispatch a partial scan.
				previous := cursor
				for _, job := range page.Items {
					if job.Id <= previous {
						return nil, response, fmt.Errorf("startup job cursor did not advance")
					}
					previous = job.Id
				}
			}
			return page, response, err
		})
		if err != nil {
			return nil, err
		}
		for _, job := range page.Items {
			ids = append(ids, job.Id)
		}
		if len(page.Items) < pageSize {
			return ids, nil
		}
		cursor = ids[len(ids)-1]
	}
}

// Both startup reads are idempotent. Retry without logging response bodies,
// which may include a credential-bearing job payload.
func readStartup[T any](ctx context.Context, log *slog.Logger, read func(context.Context) (*T, *http.Response, error)) (*T, error) {
	for ctx.Err() == nil {
		attempt, cancel := context.WithTimeout(ctx, 30*time.Second)
		result, response, err := read(attempt)
		cancel()
		if err == nil {
			return result, nil
		}
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		log.WarnContext(ctx, "Failed to read startup jobs, retrying", "http_status", status)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Second):
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
