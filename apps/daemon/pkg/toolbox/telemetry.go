// Copyright BoxLite AI (originally Daytona Platforms Inc.
// SPDX-License-Identifier: AGPL-3.0

package toolbox

import (
	"context"
	"fmt"
	"os"

	"github.com/boxlite-ai/common-go/pkg/log"
	"github.com/boxlite-ai/common-go/pkg/telemetry"
	"github.com/boxlite-ai/daemon/internal"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

// seedBootSpanFromTraceParent starts+ends one "box.boot" span parented on the propagated
// W3C traceparent (BOXLITE_TRACEPARENT, injected by the runner at box create) so the box's
// telemetry joins the SAME traceId as the api->runner spans instead of rooting a fresh trace.
// No-op when traceParent is nil/empty, so behavior is unchanged unless a trace was propagated.
// Pure (takes the tracer) so it is unit-testable with an in-memory TracerProvider.
func seedBootSpanFromTraceParent(ctx context.Context, tracer trace.Tracer, traceParent *string) {
	if traceParent == nil || *traceParent == "" {
		return
	}
	bootCtx := propagation.TraceContext{}.Extract(ctx, propagation.MapCarrier{"traceparent": *traceParent})
	_, bootSpan := tracer.Start(bootCtx, "box.boot")
	bootSpan.End()
}

func (s *server) initTelemetry(ctx context.Context, serviceName, entrypointLogFilePath string, organizationId, regionId, traceParent *string) error {
	if s.otelEndpoint == nil {
		s.logger.InfoContext(ctx, "Otel endpoint not provided, skipping telemetry initialization")
		return nil
	}

	if s.telemetry.LoggerProvider != nil {
		if err := s.telemetry.LoggerProvider.Shutdown(ctx); err != nil {
			return fmt.Errorf("failed to shutdown existing telemetry logger: %w", err)
		}
	}

	if s.telemetry.MeterProvider != nil {
		if err := s.telemetry.MeterProvider.Shutdown(ctx); err != nil {
			return fmt.Errorf("failed to shutdown existing telemetry meter provider: %w", err)
		}
	}

	if s.telemetry.TracerProvider != nil {
		if err := s.telemetry.TracerProvider.Shutdown(ctx); err != nil {
			return fmt.Errorf("failed to shutdown existing telemetry tracer provider: %w", err)
		}
	}

	config := telemetry.Config{
		ServiceName:    serviceName,
		ServiceVersion: internal.Version,
		Endpoint:       *s.otelEndpoint,
		Headers: map[string]string{
			"box-auth-token": s.authToken,
		},
	}

	extraLabels := make(map[string]string)
	if organizationId != nil && *organizationId != "" {
		extraLabels["boxlite_organization_id"] = *organizationId
	}

	if regionId != nil && *regionId != "" {
		extraLabels["boxlite_region_id"] = *regionId
	}

	if len(extraLabels) > 0 {
		config.ExtraLabels = extraLabels
	}

	// Use a background context
	telemetryContext := context.Background()

	// Initialize OpenTelemetry logging
	newLogger, lp, err := telemetry.InitLogger(telemetryContext, s.logger, config)
	if err != nil {
		return fmt.Errorf("failed to initialize logger: %w", err)
	}
	s.logger = newLogger

	if s.entrypointLogCancel != nil {
		s.entrypointLogCancel()
	}

	entrypointCtx, entrypointCancel := context.WithCancel(s.ctx)
	s.entrypointLogCancel = entrypointCancel

	go func() {
		if entrypointLogFilePath == "" {
			return
		}

		entrypointLogFile, err := os.Open(entrypointLogFilePath)
		if err != nil {
			s.logger.ErrorContext(ctx, "Failed to open entrypoint log file", "error", err, "boxlite-entrypoint", true)
			return
		}
		defer entrypointLogFile.Close()

		errChan := make(chan error, 1)
		stdoutChan := make(chan []byte)
		stderrChan := make(chan []byte)
		go log.ReadMultiplexedLog(entrypointCtx, entrypointLogFile, true, stdoutChan, stderrChan, errChan)
		for {
			select {
			case <-entrypointCtx.Done():
				return
			case line := <-stdoutChan:
				s.logger.InfoContext(telemetryContext, string(line), "boxlite-entrypoint", true)
			case line := <-stderrChan:
				s.logger.ErrorContext(telemetryContext, string(line), "boxlite-entrypoint", true)
			case err := <-errChan:
				if err != nil {
					s.logger.ErrorContext(telemetryContext, "Error reading entrypoint log file", "error", err, "boxlite-entrypoint", true)
				}
				return
			}
		}
	}()

	// Initialize OpenTelemetry metrics
	mp, err := telemetry.InitMetrics(ctx, config, "boxlite.box")
	if err != nil {
		if shutDownErr := lp.Shutdown(telemetryContext); shutDownErr != nil {
			s.logger.ErrorContext(ctx, "Failed to shutdown logger after metrics initialization failure", "shutdownErr", shutDownErr)
		}
		return fmt.Errorf("failed to initialize metrics: %w", err)
	}

	// Initialize OpenTelemetry tracing
	tp, err := telemetry.InitTracer(ctx, config)
	if err != nil {
		if shutDownErr := lp.Shutdown(telemetryContext); shutDownErr != nil {
			s.logger.ErrorContext(ctx, "Failed to shutdown logger after tracer initialization failure", "shutdownErr", shutDownErr)
		}
		if shutDownErr := mp.Shutdown(telemetryContext); shutDownErr != nil {
			s.logger.ErrorContext(ctx, "Failed to shutdown meter provider after tracer initialization failure", "shutdownErr", shutDownErr)
		}
		return fmt.Errorf("failed to initialize tracer: %w", err)
	}

	s.telemetry.TracerProvider = tp
	s.telemetry.MeterProvider = mp
	s.telemetry.LoggerProvider = lp

	// Make the box's telemetry join the api->runner traceId (instead of rooting a fresh trace).
	seedBootSpanFromTraceParent(ctx, tp.Tracer("boxlite.box"), traceParent)

	s.logger.InfoContext(ctx, "Telemetry initialized successfully")
	return nil
}
