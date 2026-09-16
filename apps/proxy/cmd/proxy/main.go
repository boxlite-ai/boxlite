// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
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
	"github.com/boxlite-ai/proxy/cmd/proxy/config"
	"github.com/boxlite-ai/proxy/internal"
	"github.com/boxlite-ai/proxy/pkg/proxy"
)

func main() {
	os.Exit(run())
}

func run() int {
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	cfg, err := config.GetConfig()
	if err != nil {
		logger.Error("Failed to get config", "error", err)
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

		tp, err := telemetry.InitTracer(ctx, telemetry.Config{
			Endpoint:       cfg.OtelEndpoint,
			Headers:        cfg.GetOtelHeaders(),
			ServiceName:    "boxlite-proxy",
			ServiceVersion: internal.Version,
			Environment:    cfg.Environment,
		})
		if err != nil {
			logger.Error("Failed to initialize tracer", "error", err)
			return 2
		}
		defer telemetry.ShutdownTracer(logger, tp)
	}

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	errChan := make(chan error, 1)
	go func() {
		errChan <- proxy.StartProxy(ctx, cfg)
	}()

	var lastSignalTime time.Time

	for {
		select {
		case <-sigChan:
			if lastSignalTime.IsZero() {
				logger.Info("Received shutdown, initiating graceful shutdown (press Ctrl+C again to force)")
				cancel()
				lastSignalTime = time.Now()
			} else if time.Since(lastSignalTime) < 100*time.Millisecond {
				// If started as a subprocess, the app might receive multiple signals in quick succession instead of one
				// Debounce very closely spaced signals
				logger.Info("Received second signal, but within debounce period, ignoring")
			} else {
				logger.Info("Received second signal, forcing exit")
				return 1
			}
		case err := <-errChan:
			if err != nil {
				logger.Error("Proxy exited with error", "error", err)
				return 1
			}
			logger.Info("Proxy exited gracefully")
			return 0
		}
	}
}

func initLogger(
	ctx context.Context,
	logger *slog.Logger,
	cfg *config.Config,
) (*slog.Logger, func(), error) {
	if !cfg.OtelLoggingEnabled || cfg.OtelEndpoint == "" {
		return logger, func() {}, nil
	}

	logger.Info("OpenTelemetry logging is enabled")
	newLogger, provider, err := telemetry.InitLogger(ctx, logger, telemetry.Config{
		Endpoint:       cfg.OtelEndpoint,
		Headers:        cfg.GetOtelHeaders(),
		ServiceName:    "boxlite-proxy",
		ServiceVersion: internal.Version,
		Environment:    cfg.Environment,
	})
	if err != nil {
		return logger, func() {}, err
	}

	return newLogger, func() {
		telemetry.ShutdownLogger(newLogger, provider)
	}, nil
}
