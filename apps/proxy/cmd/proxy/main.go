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

	log "github.com/sirupsen/logrus"
)

func main() {
	config, err := config.GetConfig()
	if err != nil {
		log.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if config.OtelTracingEnabled && config.OtelEndpoint != "" {
		log.Info("OpenTelemetry tracing is enabled")

		tp, err := telemetry.InitTracer(ctx, telemetry.Config{
			Endpoint:       config.OtelEndpoint,
			Headers:        config.GetOtelHeaders(),
			ServiceName:    "boxlite-proxy",
			ServiceVersion: internal.Version,
			Environment:    config.Environment,
		})
		if err != nil {
			log.Fatalf("Failed to initialize tracer: %v", err)
		}
		// Only flushes on the graceful-exit return below; log.Fatal paths skip
		// defers, losing at most the last unexported batch.
		defer telemetry.ShutdownTracer(slog.Default(), tp)
	}

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	errChan := make(chan error, 1)
	go func() {
		errChan <- proxy.StartProxy(ctx, config)
	}()

	var lastSignalTime time.Time

	for {
		select {
		case <-sigChan:
			if lastSignalTime.IsZero() {
				log.Info("Received shutdown, initiating graceful shutdown (press Ctrl+C again to force)")
				cancel()
				lastSignalTime = time.Now()
			} else if time.Since(lastSignalTime) < 100*time.Millisecond {
				// If started as a subprocess, the app might receive multiple signals in quick succession instead of one
				// Debounce very closely spaced signals
				log.Info("Received second signal, but within debounce period, ignoring")
			} else {
				log.Info("Received second signal, forcing exit")
				os.Exit(1)
			}
		case err := <-errChan:
			if err != nil {
				log.Fatalf("Proxy exited with error: %v", err)
			} else {
				log.Info("Proxy exited gracefully")
				return
			}
		}
	}
}
