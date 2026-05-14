// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/boxlite-ai/common-go/pkg/log"
	"github.com/boxlite-ai/common-go/pkg/telemetry"
	"github.com/boxlite-ai/runner/cmd/runner/config"
	"github.com/boxlite-ai/runner/internal"
	"github.com/boxlite-ai/runner/internal/metrics"
	"github.com/boxlite-ai/runner/pkg/api"
	"github.com/boxlite-ai/runner/pkg/backend"
	blclient "github.com/boxlite-ai/runner/pkg/boxlite"
	"github.com/boxlite-ai/runner/pkg/cache"
	"github.com/boxlite-ai/runner/pkg/runner"
	"github.com/boxlite-ai/runner/pkg/runner/v2/executor"
	"github.com/boxlite-ai/runner/pkg/runner/v2/healthcheck"
	"github.com/boxlite-ai/runner/pkg/runner/v2/poller"
	"github.com/boxlite-ai/runner/pkg/services"
	"github.com/boxlite-ai/runner/pkg/sshgateway"
	"github.com/boxlite-ai/runner/pkg/telemetry/filters"
	"github.com/lmittmann/tint"
	"github.com/mattn/go-isatty"
)

func main() {
	os.Exit(run())
}

func run() int {
	logger := slog.New(tint.NewHandler(os.Stdout, &tint.Options{
		NoColor:    !isatty.IsTerminal(os.Stdout.Fd()),
		TimeFormat: time.RFC3339,
		Level:      log.ParseLogLevel(os.Getenv("LOG_LEVEL")),
	}))

	slog.SetDefault(logger)

	cfg, err := config.GetConfig()
	if err != nil {
		logger.Error("Failed to get config", "error", err)
		return 2
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if cfg.OtelLoggingEnabled && cfg.OtelEndpoint != "" {
		logger.Info("OpenTelemetry logging is enabled")

		telemetryConfig := telemetry.Config{
			Endpoint:       cfg.OtelEndpoint,
			Headers:        cfg.GetOtelHeaders(),
			ServiceName:    "boxlite-runner",
			ServiceVersion: internal.Version,
			Environment:    cfg.Environment,
		}

		newLogger, lp, err := telemetry.InitLogger(ctx, logger, telemetryConfig)
		if err != nil {
			logger.ErrorContext(ctx, "Failed to initialize logger", "error", err)
			return 2
		}

		logger = newLogger

		defer telemetry.ShutdownLogger(logger, lp)
	}

	if cfg.OtelTracingEnabled && cfg.OtelEndpoint != "" {
		logger.Info("OpenTelemetry tracing is enabled")

		telemetryConfig := telemetry.Config{
			Endpoint:       cfg.OtelEndpoint,
			Headers:        cfg.GetOtelHeaders(),
			ServiceName:    "boxlite-runner",
			ServiceVersion: internal.Version,
			Environment:    cfg.Environment,
		}

		tp, err := telemetry.InitTracer(ctx, telemetryConfig, &filters.NotFoundExporterFilter{})
		if err != nil {
			logger.ErrorContext(ctx, "Failed to initialize tracer", "error", err)
			return 2
		}
		defer telemetry.ShutdownTracer(logger, tp)
	}

	// Initialize BoxLite runtime
	var insecureRegs []string
	if cfg.InsecureRegistries != "" {
		for _, r := range strings.Split(cfg.InsecureRegistries, ",") {
			if trimmed := strings.TrimSpace(r); trimmed != "" {
				insecureRegs = append(insecureRegs, trimmed)
			}
		}
	}

	boxliteClient, err := blclient.NewClient(ctx, blclient.ClientConfig{
		Logger:                       logger,
		HomeDir:                      cfg.BoxliteHomeDir,
		InsecureRegistries:           insecureRegs,
		AWSRegion:                    cfg.AWSRegion,
		AWSEndpointUrl:               cfg.AWSEndpointUrl,
		AWSAccessKeyId:               cfg.AWSAccessKeyId,
		AWSSecretAccessKey:           cfg.AWSSecretAccessKey,
		VolumeCleanupInterval:        cfg.VolumeCleanupInterval,
		VolumeCleanupDryRun:          cfg.VolumeCleanupDryRun,
		VolumeCleanupExclusionPeriod: cfg.VolumeCleanupExclusionPeriod,
	})
	if err != nil {
		logger.Error("Error creating BoxLite client", "error", err)
		return 2
	}
	defer boxliteClient.Close()

	logger.Info("BoxLite runtime initialized")

	backupInfoCache := cache.NewBackupInfoCache(ctx, cfg.BackupInfoCacheRetention)

	sandboxService := services.NewSandboxService(logger, backupInfoCache, boxliteClient)

	sandboxSyncService := services.NewSandboxSyncService(services.SandboxSyncServiceConfig{
		Logger:   logger,
		Boxlite:  boxliteClient,
		Interval: 10 * time.Second,
	})
	sandboxSyncService.StartSyncProcess(ctx)

	// Initialize SSH Gateway if enabled
	if sshgateway.IsSSHGatewayEnabled() {
		sshGatewayService := sshgateway.NewService(logger, boxliteClient)
		go func() {
			logger.Info("Starting SSH Gateway")
			if err := sshGatewayService.Start(ctx); err != nil {
				logger.Error("SSH Gateway error", "error", err)
			}
		}()
	} else {
		logger.Info("Gateway disabled - set SSH_GATEWAY_ENABLE=true to enable")
	}

	metricsCollector := metrics.NewCollector(metrics.CollectorConfig{
		Logger:                             logger,
		Boxlite:                            boxliteClient,
		WindowSize:                         cfg.CollectorWindowSize,
		CPUUsageSnapshotInterval:           cfg.CPUUsageSnapshotInterval,
		AllocatedResourcesSnapshotInterval: cfg.AllocatedResourcesSnapshotInterval,
	})
	metricsCollector.Start(ctx)

	_, err = runner.GetInstance(&runner.RunnerInstanceConfig{
		Logger:             logger,
		BackupInfoCache:    backupInfoCache,
		SnapshotErrorCache: cache.NewSnapshotErrorCache(ctx, cfg.SnapshotErrorCacheRetention),
		Boxlite:            boxliteClient,
		SandboxService:     sandboxService,
		MetricsCollector:   metricsCollector,
	})
	if err != nil {
		logger.Error("Failed to initialize runner instance", "error", err)
		return 2
	}

	sandboxBackend := backend.NewBoxliteAdapter(boxliteClient)

	if cfg.ApiVersion == 2 {
		healthcheckService, err := healthcheck.NewService(&healthcheck.HealthcheckServiceConfig{
			Interval:   cfg.HealthcheckInterval,
			Timeout:    cfg.HealthcheckTimeout,
			Collector:  metricsCollector,
			Logger:     logger,
			Domain:     cfg.Domain,
			ApiPort:    cfg.ApiPort,
			ProxyPort:  cfg.ApiPort,
			TlsEnabled: cfg.EnableTLS,
			Boxlite:    boxliteClient,
		})
		if err != nil {
			logger.Error("Failed to create healthcheck service", "error", err)
			return 2
		}

		go func() {
			logger.Info("Starting healthcheck service")
			healthcheckService.Start(ctx)
		}()

		executorService, err := executor.NewExecutor(&executor.ExecutorConfig{
			Logger:    logger,
			Backend:   sandboxBackend,
			Collector: metricsCollector,
		})
		if err != nil {
			logger.Error("Failed to create executor service", "error", err)
			return 2
		}

		pollerService, err := poller.NewService(&poller.PollerServiceConfig{
			PollTimeout: cfg.PollTimeout,
			PollLimit:   cfg.PollLimit,
			Logger:      logger,
			Executor:    executorService,
		})
		if err != nil {
			logger.Error("Failed to create poller service", "error", err)
			return 2
		}

		go func() {
			logger.Info("Starting poller service")
			pollerService.Start(ctx)
		}()
	}

	apiServer := api.NewApiServer(api.ApiServerConfig{
		Logger:      logger,
		ApiPort:     cfg.ApiPort,
		ApiToken:    cfg.ApiToken,
		TLSCertFile: cfg.TLSCertFile,
		TLSKeyFile:  cfg.TLSKeyFile,
		EnableTLS:   cfg.EnableTLS,
		LogRequests: cfg.ApiLogRequests,
	})

	apiServerErrChan := make(chan error)

	go func() {
		err := apiServer.Start(ctx)
		apiServerErrChan <- err
	}()

	interruptChannel := make(chan os.Signal, 1)
	signal.Notify(interruptChannel, os.Interrupt, syscall.SIGTERM)

	select {
	case err := <-apiServerErrChan:
		logger.Error("API server error", "error", err)
		return 1
	case <-interruptChannel:
		logger.Info("Signal received, shutting down")

		// Gracefully stop all running boxes BEFORE freeing the runtime / killing
		// the API server. Without this step, the systemd SIGTERM that restarts
		// this runner would kill libkrun mid-write, leaving boxes that can't
		// re-boot (the original CL84LvGx7RBE incident).
		//
		// Timeout budget: 25s is well under systemd's default
		// TimeoutStopSec=90s for the unit, leaving 60s+ for in-flight HTTP
		// handlers and the deferred Close() that follows.
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
		if err := boxliteClient.Shutdown(shutdownCtx, 25*time.Second); err != nil {
			logger.Warn("BoxLite graceful shutdown failed; boxes may be in inconsistent state", "error", err)
		}
		shutdownCancel()

		apiServer.Stop()
		logger.Info("Shutdown complete")
		return 143
	}
}
