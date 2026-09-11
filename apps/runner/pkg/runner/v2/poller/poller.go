/*
 * Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

package poller

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	runnerapiclient "github.com/boxlite-ai/runner/pkg/apiclient"
	"github.com/boxlite-ai/runner/pkg/runner/v2/executor"
)

type PollerServiceConfig struct {
	PollTimeout       time.Duration
	PollLimit         int
	MaxConcurrentJobs int
	Logger            *slog.Logger
	Executor          *executor.Executor
}

// Service handles job polling from the API
type Service struct {
	log               *slog.Logger
	pollTimeout       time.Duration
	pollLimit         int
	maxConcurrentJobs int
	mu                sync.Mutex
	running           int
	capacityChanged   chan struct{}
	executor          *executor.Executor
	client            *apiclient.APIClient
}

// NewService creates a new poller service
func NewService(cfg *PollerServiceConfig) (*Service, error) {
	if cfg.MaxConcurrentJobs < 1 {
		return nil, fmt.Errorf("max concurrent jobs must be positive, got %d", cfg.MaxConcurrentJobs)
	}
	if cfg.PollLimit < 1 || cfg.PollLimit > 100 {
		return nil, fmt.Errorf("poll limit must be between 1 and 100, got %d", cfg.PollLimit)
	}
	apiClient, err := runnerapiclient.GetApiClient()
	if err != nil {
		return nil, fmt.Errorf("failed to create API client: %w", err)
	}

	return &Service{
		log:               cfg.Logger.With(slog.String("component", "poller")),
		pollTimeout:       cfg.PollTimeout,
		pollLimit:         cfg.PollLimit,
		maxConcurrentJobs: cfg.MaxConcurrentJobs,
		capacityChanged:   make(chan struct{}, 1),
		executor:          cfg.Executor,
		client:            apiClient,
	}, nil
}

// Start begins the job polling loop
func (s *Service) Start(ctx context.Context) {
	defer s.log.InfoContext(ctx, "Job poller stopped")

	inProgressJobs, _, err := s.client.JobsAPI.ListJobs(ctx).Status(apiclient.JOBSTATUS_IN_PROGRESS).Execute()
	if err != nil {
		// Only log error
		s.log.WarnContext(ctx, "Failed to fetch IN_PROGRESS jobs", "error", err)
	} else {
		if inProgressJobs != nil && len(inProgressJobs.Items) > 0 {
			s.log.InfoContext(ctx, "Found IN_PROGRESS jobs", "count", len(inProgressJobs.Items))
			for _, job := range inProgressJobs.Items {
				if !s.execute(ctx, job) {
					return
				}
			}
		} else {
			s.log.InfoContext(ctx, "No IN_PROGRESS jobs found")
		}
	}

	s.log.InfoContext(ctx, "Starting job poller")

	for {
		capacity := s.waitForCapacity(ctx)
		if capacity == 0 {
			return
		}
		limit := min(s.pollLimit, capacity)
		jobs, err := s.pollJobs(ctx, limit)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			s.log.ErrorContext(ctx, "Failed to poll jobs", "error", err)
			retry := time.NewTimer(5 * time.Second)
			select {
			case <-ctx.Done():
				retry.Stop()
				return
			case <-retry.C:
			}
			continue
		}

		if len(jobs) > 0 {
			s.log.DebugContext(ctx, "Received jobs", "count", len(jobs))
		}
		for _, job := range jobs {
			if !s.execute(ctx, job) {
				return
			}
		}
	}
}

// MaxConcurrentJobs returns the current limit for this Runner process.
func (s *Service) MaxConcurrentJobs() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.maxConcurrentJobs
}

// SetMaxConcurrentJobs changes admission capacity without interrupting running jobs.
func (s *Service) SetMaxConcurrentJobs(limit int) error {
	if limit < 1 {
		return fmt.Errorf("max concurrent jobs must be positive, got %d", limit)
	}
	s.mu.Lock()
	s.maxConcurrentJobs = limit
	s.mu.Unlock()
	s.notifyCapacityChanged()
	return nil
}

func (s *Service) notifyCapacityChanged() {
	select {
	case s.capacityChanged <- struct{}{}:
	default:
	}
}

func (s *Service) waitForCapacity(ctx context.Context) int {
	for ctx.Err() == nil {
		s.mu.Lock()
		capacity := s.maxConcurrentJobs - s.running
		s.mu.Unlock()
		if capacity > 0 {
			return capacity
		}
		select {
		case <-ctx.Done():
			return 0
		case <-s.capacityChanged:
		}
	}
	return 0
}

func (s *Service) execute(ctx context.Context, job apiclient.Job) bool {
	for s.waitForCapacity(ctx) > 0 {
		s.mu.Lock()
		// A runtime update may reduce capacity while a poll is in flight.
		if s.running >= s.maxConcurrentJobs || ctx.Err() != nil {
			s.mu.Unlock()
			continue
		}
		s.running++
		s.mu.Unlock()
		go func() {
			defer func() {
				s.mu.Lock()
				s.running--
				s.mu.Unlock()
				s.notifyCapacityChanged()
			}()
			s.executor.Execute(ctx, &job)
		}()
		return true
	}
	return false
}

// pollJobs polls the API for pending jobs
func (s *Service) pollJobs(ctx context.Context, limit int) ([]apiclient.Job, error) {
	// Build poll request
	timeout := float32(s.pollTimeout.Seconds())

	req := s.client.JobsAPI.PollJobs(ctx).
		Timeout(timeout).
		Limit(float32(limit))

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
