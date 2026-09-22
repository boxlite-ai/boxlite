// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package config

import (
	"strings"

	"github.com/go-playground/validator/v10"
	"github.com/kelseyhightower/envconfig"
)

type Config struct {
	// Port is 4100 rather than the registry convention 5000 because macOS binds
	// 5000 for AirPlay, and a developer running the binary outside a container
	// would meet that as an unexplained refusal.
	Port int `envconfig:"REGISTRY_PROXY_PORT" default:"4100" validate:"min=1,max=65535"`
	// ShutdownTimeoutSec is an hour because a blob stream is one request and a
	// large image takes minutes: draining has to outlast the longest pull in
	// flight, or a deploy truncates it.
	ShutdownTimeoutSec int    `envconfig:"SHUTDOWN_TIMEOUT_SEC" default:"3600" validate:"min=1"`
	OtelLoggingEnabled bool   `envconfig:"OTEL_LOGGING_ENABLED"`
	OtelTracingEnabled bool   `envconfig:"OTEL_TRACING_ENABLED"`
	OtelEndpoint       string `envconfig:"OTEL_EXPORTER_OTLP_ENDPOINT"`
	OtelHeaders        string `envconfig:"OTEL_EXPORTER_OTLP_HEADERS"`
	Environment        string `envconfig:"ENVIRONMENT"`
}

// GetConfig reads the environment once and refuses to return a Config it cannot
// stand behind, so a misconfiguration is a failure to start rather than a
// failure under load.
func GetConfig() (*Config, error) {
	config := &Config{}
	if err := envconfig.Process("", config); err != nil {
		return nil, err
	}
	if err := validator.New().Struct(config); err != nil {
		return nil, err
	}
	return config, nil
}

// GetOtelHeaders splits the OTLP header list, which arrives in one variable as
// comma-separated key=value pairs.
func (c *Config) GetOtelHeaders() map[string]string {
	headers := map[string]string{}
	for _, pair := range strings.Split(c.OtelHeaders, ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		name, value, found := strings.Cut(pair, "=")
		if !found {
			continue
		}
		headers[strings.TrimSpace(name)] = strings.TrimSpace(value)
	}
	return headers
}
