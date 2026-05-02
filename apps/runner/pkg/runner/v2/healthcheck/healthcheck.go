/*
 * Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

package healthcheck

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	"github.com/boxlite-ai/runner/internal"
	"github.com/boxlite-ai/runner/internal/metrics"
	runnerapiclient "github.com/boxlite-ai/runner/pkg/apiclient"
	blclient "github.com/boxlite-ai/runner/pkg/boxlite"
)

type HealthcheckServiceConfig struct {
	Interval   time.Duration
	Timeout    time.Duration
	Collector  *metrics.Collector
	Logger     *slog.Logger
	Domain     string
	ApiPort    int
	ProxyPort  int
	TlsEnabled bool
	Boxlite    *blclient.Client
}

type Service struct {
	log        *slog.Logger
	interval   time.Duration
	timeout    time.Duration
	collector  *metrics.Collector
	client     *apiclient.APIClient
	domain     string
	apiPort    int
	proxyPort  int
	tlsEnabled bool
	boxlite    *blclient.Client
}

func NewService(cfg *HealthcheckServiceConfig) (*Service, error) {
	apiClient, err := runnerapiclient.GetApiClient()
	if err != nil {
		return nil, fmt.Errorf("failed to create API client: %w", err)
	}

	if cfg.Boxlite == nil {
		return nil, fmt.Errorf("boxlite client is required for healthcheck service")
	}

	logger := slog.Default()
	if cfg.Logger != nil {
		logger = cfg.Logger
	}

	return &Service{
		log:        logger.With(slog.String("component", "healthcheck")),
		client:     apiClient,
		interval:   cfg.Interval,
		timeout:    cfg.Timeout,
		collector:  cfg.Collector,
		domain:     cfg.Domain,
		apiPort:    cfg.ApiPort,
		proxyPort:  cfg.ProxyPort,
		tlsEnabled: cfg.TlsEnabled,
		boxlite:    cfg.Boxlite,
	}, nil
}

func (s *Service) Start(ctx context.Context) {
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()

	if err := s.sendHealthcheck(ctx); err != nil {
		s.log.WarnContext(ctx, "Failed to send initial healthcheck", "error", err)
	}

	for {
		select {
		case <-ctx.Done():
			s.log.InfoContext(ctx, "Healthcheck loop stopped")
			return
		case <-ticker.C:
			if err := s.sendHealthcheck(ctx); err != nil {
				s.log.WarnContext(ctx, "Failed to send healthcheck", "error", err)
			}
		}
	}
}

func (s *Service) sendHealthcheck(ctx context.Context) error {
	reqCtx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()

	healthcheck := apiclient.NewRunnerHealthcheck(internal.Version)
	healthcheck.SetDomain(s.domain)

	proxyUrl := fmt.Sprintf("http://%s:%d", s.domain, s.proxyPort)
	apiUrl := fmt.Sprintf("http://%s:%d", s.domain, s.apiPort)

	if s.tlsEnabled {
		apiUrl = fmt.Sprintf("https://%s:%d", s.domain, s.apiPort)
		proxyUrl = fmt.Sprintf("https://%s:%d", s.domain, s.proxyPort)
	}

	healthcheck.SetProxyUrl(proxyUrl)
	healthcheck.SetApiUrl(apiUrl)

	runtimeHealth := apiclient.RunnerServiceHealth{
		ServiceName: "boxlite",
		Healthy:     true,
	}

	err := s.boxlite.Ping(reqCtx)
	if err != nil {
		s.log.WarnContext(reqCtx, "Failed to ping BoxLite runtime", "error", err)

		errStr := err.Error()
		runtimeHealth.Healthy = false
		runtimeHealth.ErrorReason = &errStr
	}

	healthcheck.SetServiceHealth([]apiclient.RunnerServiceHealth{runtimeHealth})

	m, err := s.collector.Collect(reqCtx)
	if err != nil {
		s.log.WarnContext(reqCtx, "Failed to collect metrics for healthcheck", "error", err)
	} else {
		healthcheck.SetMetrics(apiclient.RunnerHealthMetrics{
			CurrentCpuLoadAverage:        m.CPULoadAverage,
			CurrentCpuUsagePercentage:    m.CPUUsagePercentage,
			CurrentMemoryUsagePercentage: m.MemoryUsagePercentage,
			CurrentDiskUsagePercentage:   m.DiskUsagePercentage,
			CurrentAllocatedCpu:          m.AllocatedCPU,
			CurrentAllocatedMemoryGiB:    m.AllocatedMemoryGiB,
			CurrentAllocatedDiskGiB:      m.AllocatedDiskGiB,
			CurrentSnapshotCount:         m.SnapshotCount,
			CurrentStartedSandboxes:      m.StartedSandboxCount,
			Cpu:                          m.TotalCPU,
			MemoryGiB:                    m.TotalRAMGiB,
			DiskGiB:                      m.TotalDiskGiB,
		})
	}

	req := s.client.RunnersAPI.RunnerHealthcheck(reqCtx).RunnerHealthcheck(*healthcheck)
	_, err = req.Execute()
	if err != nil {
		return err
	}

	s.log.DebugContext(reqCtx, "Healthcheck sent successfully")
	return nil
}
