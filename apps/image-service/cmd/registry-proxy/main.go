// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/boxlite-ai/common-go/pkg/telemetry"
	"github.com/boxlite-ai/image-service/cmd/registry-proxy/config"
	"github.com/boxlite-ai/image-service/internal"
	"github.com/boxlite-ai/image-service/internal/proxy"
)

func main() {
	os.Exit(run())
}

func run() int {
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	cfg, err := config.GetConfig()
	if err != nil {
		logger.Error("Failed to read config", "error", err)
		return 2
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	logger, shutdownLogger, err := initLogger(ctx, logger, cfg)
	if err != nil {
		logger.Error("Failed to initialize logger", "error", err)
		return 2
	}
	defer shutdownLogger()

	if cfg.OtelTracingEnabled && cfg.OtelEndpoint != "" {
		logger.Info("OpenTelemetry tracing is enabled")
		tracerProvider, err := telemetry.InitTracer(ctx, telemetryConfig(cfg))
		if err != nil {
			logger.Error("Failed to initialize tracer", "error", err)
			return 2
		}
		defer telemetry.ShutdownTracer(logger, tracerProvider)
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)

	serveErr := make(chan error, 1)
	go func() { serveErr <- proxy.Start(ctx, cfg) }()

	return await(logger, signals, serveErr, cancel)
}

// signalDebounce is how close together two shutdown signals have to be for the
// second one to be the same shutdown rather than an operator insisting.
const signalDebounce = 100 * time.Millisecond

// await blocks until the server stops, and returns the exit status.
//
// The first shutdown signal starts a drain, because a blob stream in flight is
// an image being assembled and cutting it costs the puller the whole pull. A
// second one abandons it — but only if it is far enough from the first to be a
// second intent: started as a subprocess, one shutdown arrives as several
// signals at once, and taking those as "force" would make every restart a hard
// kill.
func await(logger *slog.Logger, signals <-chan os.Signal, serveErr <-chan error, drain func()) int {
	var firstSignal time.Time
	for {
		select {
		case <-signals:
			switch {
			case firstSignal.IsZero():
				logger.Info("Received shutdown, draining (signal again to force)")
				drain()
				firstSignal = time.Now()
			case time.Since(firstSignal) < signalDebounce:
				logger.Info("Ignoring a second signal within the debounce window")
			default:
				logger.Info("Received a second signal, forcing exit")
				return 1
			}
		case err := <-serveErr:
			if err != nil {
				logger.Error("Registry proxy exited with error", "error", err)
				return 1
			}
			logger.Info("Registry proxy exited gracefully")
			return 0
		}
	}
}

func initLogger(ctx context.Context, logger *slog.Logger, cfg *config.Config) (*slog.Logger, func(), error) {
	if !cfg.OtelLoggingEnabled || cfg.OtelEndpoint == "" {
		return logger, func() {}, nil
	}

	logger.Info("OpenTelemetry logging is enabled")
	otelLogger, provider, err := telemetry.InitLogger(ctx, logger, telemetryConfig(cfg))
	if err != nil {
		return logger, func() {}, err
	}
	return otelLogger, func() { telemetry.ShutdownLogger(otelLogger, provider) }, nil
}

func telemetryConfig(cfg *config.Config) telemetry.Config {
	return telemetry.Config{
		Endpoint:       cfg.OtelEndpoint,
		Headers:        cfg.GetOtelHeaders(),
		ServiceName:    proxy.ServiceName,
		ServiceVersion: internal.Version,
		Environment:    cfg.Environment,
	}
}
