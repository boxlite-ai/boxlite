/*
 * Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

package healthcheck

import (
	"context"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
	boxlite "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/internal"
	"github.com/boxlite-ai/runner/internal/metrics"
	runnerapiclient "github.com/boxlite-ai/runner/pkg/apiclient"
	blclient "github.com/boxlite-ai/runner/pkg/boxlite"
)

type HealthcheckServiceConfig struct {
	Interval          time.Duration
	Timeout           time.Duration
	Collector         *metrics.Collector
	Logger            *slog.Logger
	Domain            string
	ApiPort           int
	ProxyPort         int
	TlsEnabled        bool
	Boxlite           *blclient.Client
	RunnerEpoch       string
	RunnerIncarnation int64
	Generations       GenerationResolver
}

type GenerationResolver interface {
	Generation(boxID string) int64
	ObserveRunning(boxID string) (int64, error)
}

type Service struct {
	log               *slog.Logger
	interval          time.Duration
	timeout           time.Duration
	collector         *metrics.Collector
	client            *apiclient.APIClient
	domain            string
	apiPort           int
	proxyPort         int
	tlsEnabled        bool
	boxlite           *blclient.Client
	runnerEpoch       string
	runnerIncarnation int64
	sequence          atomic.Int64
	generations       GenerationResolver
}

func NewService(cfg *HealthcheckServiceConfig) (*Service, error) {
	apiClient, err := runnerapiclient.GetApiClient()
	if err != nil {
		return nil, fmt.Errorf("failed to create API client: %w", err)
	}

	if cfg.Boxlite == nil {
		return nil, fmt.Errorf("boxlite client is required for healthcheck service")
	}
	if cfg.RunnerEpoch == "" {
		return nil, fmt.Errorf("runner epoch is required for healthcheck service")
	}
	if cfg.RunnerIncarnation <= 0 {
		return nil, fmt.Errorf("runner incarnation must be positive for healthcheck service")
	}

	logger := slog.Default()
	if cfg.Logger != nil {
		logger = cfg.Logger
	}

	return &Service{
		log:               logger.With(slog.String("component", "healthcheck")),
		client:            apiClient,
		interval:          cfg.Interval,
		timeout:           cfg.Timeout,
		collector:         cfg.Collector,
		domain:            cfg.Domain,
		apiPort:           cfg.ApiPort,
		proxyPort:         cfg.ProxyPort,
		tlsEnabled:        cfg.TlsEnabled,
		boxlite:           cfg.Boxlite,
		runnerEpoch:       cfg.RunnerEpoch,
		runnerIncarnation: cfg.RunnerIncarnation,
		generations:       cfg.Generations,
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

	healthcheck := apiclient.NewRunnerHealthcheck(
		s.runnerEpoch,
		s.runnerIncarnation,
		s.sequence.Add(1),
		internal.Version,
	)
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

	boxes, err := s.boxlite.ListInfo(reqCtx)
	if err != nil {
		s.log.WarnContext(reqCtx, "Failed to collect box inventory for healthcheck", "error", err)
	} else {
		inventory, inventoryErr := buildBoxInventory(boxes, s.generations)
		if inventoryErr != nil {
			s.log.WarnContext(reqCtx, "Failed to reconcile box inventory generations", "error", inventoryErr)
		} else {
			healthcheck.SetBoxes(inventory)
		}
	}

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
			CurrentStartedBoxes:          m.StartedBoxCount,
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

func buildBoxInventory(
	boxes []boxlite.BoxInfo,
	generations GenerationResolver,
) ([]apiclient.RunnerBoxObservation, error) {
	inventory := make([]apiclient.RunnerBoxObservation, 0, len(boxes))
	for _, box := range boxes {
		boxID := box.Name
		if boxID == "" {
			boxID = box.ID
		}
		runtimeGeneration := int64(0)
		if generations != nil {
			if box.State == boxlite.StateRunning {
				var err error
				runtimeGeneration, err = generations.ObserveRunning(boxID)
				if err != nil {
					return nil, err
				}
			} else {
				runtimeGeneration = generations.Generation(boxID)
			}
		}
		inventory = append(inventory, apiclient.RunnerBoxObservation{
			BoxId:             boxID,
			ActualState:       toAPIBoxState(box.State),
			RuntimeGeneration: runtimeGeneration,
		})
	}
	return inventory, nil
}

func toAPIBoxState(state boxlite.State) apiclient.BoxState {
	switch state {
	case boxlite.StateConfigured:
		return apiclient.BOXSTATE_CREATING
	case boxlite.StateRunning:
		return apiclient.BOXSTATE_STARTED
	case boxlite.StateStopping:
		return apiclient.BOXSTATE_STOPPING
	case boxlite.StateStopped:
		return apiclient.BOXSTATE_STOPPED
	default:
		return apiclient.BOXSTATE_UNKNOWN
	}
}
