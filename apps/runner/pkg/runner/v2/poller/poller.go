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
)

// jobExecutor runs a single job to completion. *executor.Executor satisfies it;
// tests inject a fake to observe execution concurrency. Depending on the
// interface rather than the concrete executor also keeps this package free of
// the CGO boxlite dependency, so it stays unit-testable without a built VM lib.
type jobExecutor interface {
	Execute(ctx context.Context, job *apiclient.Job)
}

type PollerServiceConfig struct {
	PollTimeout            time.Duration
	PollLimit              int
	MaxConcurrentSpawnJobs int
	Logger                 *slog.Logger
	Executor               jobExecutor
}

// Service handles job polling from the API
type Service struct {
	log         *slog.Logger
	pollTimeout time.Duration
	pollLimit   int
	executor    jobExecutor
	client      *apiclient.APIClient
	// spawnSem bounds how many VM-spawning jobs (create/start/recover) run
	// concurrently. On boot a runner replays every in-flight job and the API
	// keeps dispatching more; unbounded, each spawns a ~180MB libkrun VM at
	// once and OOMs the host (the prod reboot loop). Non-spawn jobs
	// (stop/destroy/resize) bypass it so cleanup never waits behind spawns.
	spawnSem chan struct{}
}

// NewService creates a new poller service
func NewService(cfg *PollerServiceConfig) (*Service, error) {
	apiClient, err := runnerapiclient.GetApiClient()
	if err != nil {
		return nil, fmt.Errorf("failed to create API client: %w", err)
	}

	maxSpawns := cfg.MaxConcurrentSpawnJobs
	if maxSpawns < 1 {
		maxSpawns = 1
	}

	return &Service{
		log:         cfg.Logger.With(slog.String("component", "poller")),
		pollTimeout: cfg.PollTimeout,
		pollLimit:   cfg.PollLimit,
		executor:    cfg.Executor,
		client:      apiClient,
		spawnSem:    make(chan struct{}, maxSpawns),
	}, nil
}

// Start begins the job polling loop
func (s *Service) Start(ctx context.Context) {
	inProgressJobs, _, err := s.client.JobsAPI.ListJobs(ctx).Status(apiclient.JOBSTATUS_IN_PROGRESS).Execute()
	if err != nil {
		// Only log error
		s.log.WarnContext(ctx, "Failed to fetch IN_PROGRESS jobs", "error", err)
	} else {
		if inProgressJobs != nil && len(inProgressJobs.Items) > 0 {
			s.log.InfoContext(ctx, "Found IN_PROGRESS jobs", "count", len(inProgressJobs.Items))
			for _, job := range inProgressJobs.Items {
				s.dispatch(ctx, &job)
			}
		} else {
			s.log.InfoContext(ctx, "No IN_PROGRESS jobs found")
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
					s.dispatch(ctx, &job)
				}
			}
		}
	}
}

// dispatch runs a job asynchronously. Spawn jobs acquire a spawnSem slot first
// so that a boot-time replay storm (or a flood of START_BOX from the API)
// applies backpressure to the caller instead of starting every libkrun VM at
// once. Non-spawn jobs run immediately so cleanup is never blocked behind spawns.
func (s *Service) dispatch(ctx context.Context, job *apiclient.Job) {
	if !isSpawnJob(job) {
		go s.executor.Execute(ctx, job)
		return
	}

	select {
	case s.spawnSem <- struct{}{}:
	case <-ctx.Done():
		return
	}
	go func() {
		defer func() { <-s.spawnSem }()
		s.executor.Execute(ctx, job)
	}()
}

// isSpawnJob reports whether a job starts a libkrun VM (and so consumes ~180MB
// of host memory). Only these are bounded by the spawn gate.
func isSpawnJob(job *apiclient.Job) bool {
	switch job.GetType() {
	case apiclient.JOBTYPE_CREATE_BOX, apiclient.JOBTYPE_START_BOX, apiclient.JOBTYPE_RECOVER_BOX:
		return true
	default:
		return false
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
