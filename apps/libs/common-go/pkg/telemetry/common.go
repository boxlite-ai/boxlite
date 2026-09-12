// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: Apache-2.0

package telemetry

import (
	"crypto/tls"
	"os"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.37.0"
)

type Config struct {
	Endpoint       string
	Headers        map[string]string
	ServiceName    string
	ServiceVersion string
	Environment    string
	ExtraLabels    map[string]string
	TLSConfig      *tls.Config
	/*
		The audience to mint a Google ID token for, or empty for no token.

		Set only where the endpoint authorises by caller — a Cloud Run collector
		with an invoker list. It is the collector's base URL, not a path under
		it: Cloud Run checks the token's `aud` against the service's own
		address. Empty on AWS, where the endpoint is an internal load balancer
		and there is no per-request identity to prove. See `gcp_idtoken.go`.
	*/
	GoogleIDTokenAudience string
}

func (c Config) Attributes() []attribute.KeyValue {
	hostname, err := os.Hostname()
	if err != nil || hostname == "" {
		hostname = "unknown"
	}

	attributes := []attribute.KeyValue{
		semconv.ServiceName(c.ServiceName),
		semconv.ServiceVersion(c.ServiceVersion),
		semconv.ServiceInstanceID(hostname),
		semconv.DeploymentEnvironmentName(c.Environment),
	}

	for k, v := range c.ExtraLabels {
		attributes = append(attributes, attribute.String(k, v))
	}

	return attributes
}

type ExporterFilter interface {
	Apply(exporter trace.SpanExporter) trace.SpanExporter
}
