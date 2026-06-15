// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package config

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/go-playground/validator/v10"
	"github.com/kelseyhightower/envconfig"
)

type Config struct {
	BoxliteApiUrl                      string        `envconfig:"BOXLITE_API_URL"`
	ApiToken                           string        `envconfig:"BOXLITE_RUNNER_TOKEN"`
	ApiPort                            int           `envconfig:"API_PORT"`
	ApiLogRequests                     bool          `envconfig:"API_LOG_REQUESTS" default:"false"`
	TLSCertFile                        string        `envconfig:"TLS_CERT_FILE"`
	TLSKeyFile                         string        `envconfig:"TLS_KEY_FILE"`
	EnableTLS                          bool          `envconfig:"ENABLE_TLS"`
	OtelLoggingEnabled                 bool          `envconfig:"OTEL_LOGGING_ENABLED"`
	OtelTracingEnabled                 bool          `envconfig:"OTEL_TRACING_ENABLED"`
	OtelEndpoint                       string        `envconfig:"OTEL_EXPORTER_OTLP_ENDPOINT"`
	OtelHeaders                        string        `envconfig:"OTEL_EXPORTER_OTLP_HEADERS"`
	Environment                        string        `envconfig:"ENVIRONMENT"`
	ContainerRuntime                   string        `envconfig:"CONTAINER_RUNTIME"`
	ContainerNetwork                   string        `envconfig:"CONTAINER_NETWORK"`
	InterBoxNetworkEnabled             bool          `envconfig:"INTER_BOX_NETWORK_ENABLED" default:"true"`
	LogFilePath                        string        `envconfig:"LOG_FILE_PATH"`
	AWSRegion                          string        `envconfig:"AWS_REGION"`
	AWSEndpointUrl                     string        `envconfig:"AWS_ENDPOINT_URL"`
	AWSAccessKeyId                     string        `envconfig:"AWS_ACCESS_KEY_ID"`
	AWSSecretAccessKey                 string        `envconfig:"AWS_SECRET_ACCESS_KEY"`
	AWSDefaultBucket                   string        `envconfig:"AWS_DEFAULT_BUCKET"`
	ResourceLimitsDisabled             bool          `envconfig:"RESOURCE_LIMITS_DISABLED"`
	DaemonStartTimeoutSec              int           `envconfig:"DAEMON_START_TIMEOUT_SEC"`
	BoxStartTimeoutSec                 int           `envconfig:"BOX_START_TIMEOUT_SEC"`
	UseSnapshotEntrypoint              bool          `envconfig:"USE_SNAPSHOT_ENTRYPOINT"`
	Domain                             string        `envconfig:"RUNNER_DOMAIN" validate:"omitempty,hostname|ip"`
	VolumeCleanupInterval              time.Duration `envconfig:"VOLUME_CLEANUP_INTERVAL" default:"30s" validate:"min=10s"`
	VolumeCleanupDryRun                bool          `envconfig:"VOLUME_CLEANUP_DRY_RUN" default:"true"`
	VolumeCleanupExclusionPeriod       time.Duration `envconfig:"VOLUME_CLEANUP_EXCLUSION_PERIOD" default:"120s" validate:"min=0s"`
	PollTimeout                        time.Duration `envconfig:"POLL_TIMEOUT" default:"30s"`
	PollLimit                          int           `envconfig:"POLL_LIMIT" default:"10" validate:"min=1,max=100"`
	CollectorWindowSize                int           `envconfig:"COLLECTOR_WINDOW_SIZE" default:"60" validate:"min=1"`
	CPUUsageSnapshotInterval           time.Duration `envconfig:"CPU_USAGE_SNAPSHOT_INTERVAL" default:"5s" validate:"min=1s"`
	AllocatedResourcesSnapshotInterval time.Duration `envconfig:"ALLOCATED_RESOURCES_SNAPSHOT_INTERVAL" default:"5s" validate:"min=1s"`
	HealthcheckInterval                time.Duration `envconfig:"HEALTHCHECK_INTERVAL" default:"30s" validate:"min=10s"`
	HealthcheckTimeout                 time.Duration `envconfig:"HEALTHCHECK_TIMEOUT" default:"10s"`
	BuildTimeoutMin                    int           `envconfig:"BUILD_TIMEOUT_MIN" default:"120" validate:"min=1"`
	BuildCPUCores                      int64         `envconfig:"BUILD_CPU_CORES" default:"4" validate:"min=1"`
	BuildMemoryGB                      int64         `envconfig:"BUILD_MEMORY_GB" default:"8" validate:"min=1"`
	ApiVersion                         int           `envconfig:"API_VERSION" default:"2"`
	InitializeDaemonTelemetry          bool          `envconfig:"INITIALIZE_DAEMON_TELEMETRY" default:"true"`
	BuildEngine                        string        `envconfig:"BUILD_ENGINE" default:"buildkit" validate:"oneof=buildkit legacy"`
	BoxliteHomeDir                     string        `envconfig:"BOXLITE_HOME_DIR"`
	InsecureRegistries                 string        `envconfig:"INSECURE_REGISTRIES"`
	GhcrUsername                       string        `envconfig:"GHCR_USERNAME"`
	GhcrToken                          string        `envconfig:"GHCR_TOKEN"`
}

var DEFAULT_API_PORT int = 8080

var config *Config

func GetConfig() (*Config, error) {
	if config != nil {
		return config, nil
	}

	config = &Config{}

	err := envconfig.Process("", config)
	if err != nil {
		return nil, err
	}

	var validate = validator.New()
	err = validate.Struct(config)
	if err != nil {
		return nil, err
	}

	if config.BoxliteApiUrl == "" {
		// For backward compatibility
		serverUrl := os.Getenv("SERVER_URL")
		if serverUrl == "" {
			return nil, fmt.Errorf("BOXLITE_API_URL or SERVER_URL is required")
		}
		config.BoxliteApiUrl = serverUrl
	}

	if config.ApiToken == "" {
		// For backward compatibility
		apiToken := os.Getenv("API_TOKEN")
		if apiToken == "" {
			return nil, fmt.Errorf("BOXLITE_RUNNER_TOKEN or API_TOKEN is required")
		}
		config.ApiToken = apiToken
	}

	if config.ApiPort == 0 {
		config.ApiPort = DEFAULT_API_PORT
	}

	if config.Domain == "" {
		ip, err := getOutboundIP()
		if err != nil {
			return nil, err
		}
		config.Domain = ip.String()
	}

	return config, nil
}

func (c *Config) GetOtelHeaders() map[string]string {
	headers := map[string]string{}
	for _, pair := range strings.Split(c.OtelHeaders, ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}

		k, v, found := strings.Cut(pair, "=")
		if !found {
			continue
		}

		headers[strings.TrimSpace(k)] = strings.TrimSpace(v)
	}

	return headers
}

func GetContainerRuntime() string {
	return config.ContainerRuntime
}

func GetContainerNetwork() string {
	return config.ContainerNetwork
}

func GetEnvironment() string {
	return config.Environment
}

func GetBuildEngine() string {
	return config.BuildEngine
}
