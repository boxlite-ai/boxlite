// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package runner

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/boxlite-ai/runner/internal/metrics"
	blclient "github.com/boxlite-ai/runner/pkg/boxlite"
	"github.com/boxlite-ai/runner/pkg/cache"
	"github.com/boxlite-ai/runner/pkg/models"
	"github.com/boxlite-ai/runner/pkg/services"
)

type RunnerInstanceConfig struct {
	Logger             *slog.Logger
	BackupInfoCache    *cache.BackupInfoCache
	SnapshotErrorCache *cache.SnapshotErrorCache
	Boxlite            *blclient.Client
	MetricsCollector   *metrics.Collector
	SandboxService     *services.SandboxService
}

type Runner struct {
	Logger             *slog.Logger
	BackupInfoCache    *cache.BackupInfoCache
	SnapshotErrorCache *cache.SnapshotErrorCache
	Boxlite            *blclient.Client
	MetricsCollector   *metrics.Collector
	SandboxService     *services.SandboxService
}

var runner *Runner

func GetInstance(config *RunnerInstanceConfig) (*Runner, error) {
	if config != nil && runner != nil {
		return nil, errors.New("runner instance already initialized")
	}

	if runner == nil {
		if config == nil {
			return nil, errors.New("runner instance not initialized and no config provided")
		}

		logger := slog.Default()
		if config.Logger != nil {
			logger = config.Logger
		}

		runner = &Runner{
			Logger:             logger.With(slog.String("component", "runner")),
			BackupInfoCache:    config.BackupInfoCache,
			SnapshotErrorCache: config.SnapshotErrorCache,
			Boxlite:            config.Boxlite,
			SandboxService:     config.SandboxService,
			MetricsCollector:   config.MetricsCollector,
		}
	}

	return runner, nil
}

func (r *Runner) InspectRunnerServices(ctx context.Context) []models.RunnerServiceInfo {
	runnerServicesInfo := make([]models.RunnerServiceInfo, 0)

	pingCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	boxliteHealth := models.RunnerServiceInfo{
		ServiceName: "boxlite",
		Healthy:     true,
	}

	err := r.Boxlite.Ping(pingCtx)
	if err != nil {
		r.Logger.WarnContext(ctx, "Failed to ping BoxLite runtime", "error", err)
		boxliteHealth.Healthy = false
		boxliteHealth.Err = err
	}

	runnerServicesInfo = append(runnerServicesInfo, boxliteHealth)

	return runnerServicesInfo
}
