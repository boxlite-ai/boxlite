// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package config

import (
	"strings"
	"time"

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
	ShutdownTimeoutSec int `envconfig:"SHUTDOWN_TIMEOUT_SEC" default:"3600" validate:"min=1"`

	// BoxliteApiUrl is the control plane. A runner API key is an opaque column
	// rather than a signed token, so there is no way to check a caller without
	// asking, and no point starting without somewhere to ask.
	BoxliteApiUrl string `envconfig:"BOXLITE_API_URL" validate:"required,url"`
	// UpstreamHosts are the registries this proxy will pull from. The upstream
	// arrives in the request path, so without a list the caller chooses what
	// this process connects to.
	UpstreamHosts []string `envconfig:"REGISTRY_PROXY_UPSTREAM_HOSTS" default:"ghcr.io,docker.io" validate:"required,min=1"`
	// CredentialTTL is how long a verified caller is taken on trust before the
	// control plane is asked again. It is the delay between revoking a runner
	// and this proxy noticing.
	CredentialTTL time.Duration `envconfig:"REGISTRY_PROXY_CREDENTIAL_TTL" default:"60s" validate:"min=1s"`
	// RejectionTTL is how long a refused credential is remembered. Without it,
	// a caller that keeps presenting a bad key turns this proxy into a load
	// generator aimed at the control plane.
	RejectionTTL time.Duration `envconfig:"REGISTRY_PROXY_REJECTION_TTL" default:"30s" validate:"min=1s"`
	// PullsPerSecond and PullBurst cap the request rate of one runner, and
	// separately of one organization. They count requests, not bytes: a
	// manifest and its layers are a few dozen requests, so the burst has to
	// clear a whole image comfortably.
	PullsPerSecond float64 `envconfig:"REGISTRY_PROXY_PULLS_PER_SECOND" default:"50" validate:"gt=0"`
	PullBurst      int     `envconfig:"REGISTRY_PROXY_PULL_BURST" default:"200" validate:"min=1"`
	// TrackedMeters bounds how many runners and organizations are metered at
	// once. The organization comes from the request path, so the set is partly
	// caller-supplied and cannot be left to grow. Past the bound, callers share
	// one meter rather than being refused.
	TrackedMeters int `envconfig:"REGISTRY_PROXY_TRACKED_METERS" default:"4096" validate:"min=1"`
	// UpstreamTimeout bounds connecting to a registry and its TLS handshake, not
	// the body: a blob legitimately takes minutes to stream. It also bounds a
	// whole control-plane request, which is a small JSON call with nothing to
	// stream.
	UpstreamTimeout time.Duration `envconfig:"REGISTRY_PROXY_UPSTREAM_TIMEOUT" default:"30s" validate:"min=1s"`

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
