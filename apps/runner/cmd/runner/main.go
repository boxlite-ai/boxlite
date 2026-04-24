// Copyright 2025 Daytona Platforms Inc.
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

	"github.com/daytonaio/common-go/pkg/log"
	"github.com/daytonaio/common-go/pkg/telemetry"
	"github.com/daytonaio/runner/cmd/runner/config"
	"github.com/daytonaio/runner/internal"
	"github.com/daytonaio/runner/internal/metrics"
	"github.com/daytonaio/runner/pkg/api"
	"github.com/daytonaio/runner/pkg/backend"
	blclient "github.com/daytonaio/runner/pkg/boxlite"
	"github.com/daytonaio/runner/pkg/cache"
	"github.com/daytonaio/runner/pkg/daemon"
	"github.com/daytonaio/runner/pkg/runner"
	"github.com/daytonaio/runner/pkg/runner/v2/executor"
	"github.com/daytonaio/runner/pkg/runner/v2/healthcheck"
	"github.com/daytonaio/runner/pkg/runner/v2/poller"
	"github.com/daytonaio/runner/pkg/services"
	"github.com/daytonaio/runner/pkg/sshgateway"
	"github.com/daytonaio/runner/pkg/telemetry/filters"
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
			ServiceName:    "daytona-runner",
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
			ServiceName:    "daytona-runner",
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

	daemonPath, _ := daemon.WriteStaticBinary("daemon-amd64")

	boxliteClient, err := blclient.NewClient(ctx, blclient.ClientConfig{
		Logger:             logger,
		HomeDir:            cfg.BoxliteHomeDir,
		InsecureRegistries: insecureRegs,
		DaemonPath:         daemonPath,
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
		apiServer.Stop()
		logger.Info("Shutdown complete")
		return 143
	}
}
