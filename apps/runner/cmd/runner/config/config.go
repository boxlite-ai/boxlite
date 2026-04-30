// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package config

import (
	"fmt"
	"os"
	"path/filepath"
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
	BackupInfoCacheRetention           time.Duration `envconfig:"BACKUP_INFO_CACHE_RETENTION" default:"168h" validate:"min=5m"`
	Environment                        string        `envconfig:"ENVIRONMENT"`
	ContainerRuntime                   string        `envconfig:"CONTAINER_RUNTIME"`
	ContainerNetwork                   string        `envconfig:"CONTAINER_NETWORK"`
	InterSandboxNetworkEnabled         bool          `envconfig:"INTER_SANDBOX_NETWORK_ENABLED" default:"true"`
	LogFilePath                        string        `envconfig:"LOG_FILE_PATH"`
	AWSRegion                          string        `envconfig:"AWS_REGION"`
	AWSEndpointUrl                     string        `envconfig:"AWS_ENDPOINT_URL"`
	AWSAccessKeyId                     string        `envconfig:"AWS_ACCESS_KEY_ID"`
	AWSSecretAccessKey                 string        `envconfig:"AWS_SECRET_ACCESS_KEY"`
	AWSDefaultBucket                   string        `envconfig:"AWS_DEFAULT_BUCKET"`
	ResourceLimitsDisabled             bool          `envconfig:"RESOURCE_LIMITS_DISABLED"`
	DaemonStartTimeoutSec              int           `envconfig:"DAEMON_START_TIMEOUT_SEC"`
	SandboxStartTimeoutSec             int           `envconfig:"SANDBOX_START_TIMEOUT_SEC"`
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
	BackupTimeoutMin                   int           `envconfig:"BACKUP_TIMEOUT_MIN" default:"60" validate:"min=1"`
	SnapshotPullTimeout                time.Duration `envconfig:"SNAPSHOT_PULL_TIMEOUT" default:"60m" validate:"min=1m"`
	BuildTimeoutMin                    int           `envconfig:"BUILD_TIMEOUT_MIN" default:"120" validate:"min=1"`
	BuildCPUCores                      int64         `envconfig:"BUILD_CPU_CORES" default:"4" validate:"min=1"`
	BuildMemoryGB                      int64         `envconfig:"BUILD_MEMORY_GB" default:"8" validate:"min=1"`
	ApiVersion                         int           `envconfig:"API_VERSION" default:"2"`
	InitializeDaemonTelemetry          bool          `envconfig:"INITIALIZE_DAEMON_TELEMETRY" default:"true"`
	SnapshotErrorCacheRetention        time.Duration `envconfig:"SNAPSHOT_ERROR_CACHE_RETENTION" default:"10m" validate:"min=5m"`
	BuildEngine                        string        `envconfig:"BUILD_ENGINE" default:"buildkit" validate:"oneof=buildkit legacy"`
	BoxliteHomeDir                     string        `envconfig:"BOXLITE_HOME_DIR"`
	InsecureRegistries                 string        `envconfig:"INSECURE_REGISTRIES"`
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

func GetBuildLogFilePath(snapshotRef string) (string, error) {
	// Extract image name from various snapshot ref formats:
	// - registry:5000/boxlite/boxlite-<hash>
	// - boxlite-<hash>
	// - boxlite-<hash>:tag
	// - cr.preprod.boxlite.ai/sbox/boxlite/boxlite-<hash>:boxlite

	buildId := snapshotRef

	// Remove tag if present (everything after last colon that's not part of a port)
	// A tag colon will come after the last slash
	lastSlashIndex := strings.LastIndex(buildId, "/")
	lastColonIndex := strings.LastIndex(buildId, ":")

	if lastColonIndex > lastSlashIndex && lastColonIndex != -1 {
		// This colon is a tag separator, not a port separator
		buildId = buildId[:lastColonIndex]
	}

	// Extract the image name (last component after the last slash)
	if lastSlashIndex := strings.LastIndex(buildId, "/"); lastSlashIndex != -1 {
		buildId = buildId[lastSlashIndex+1:]
	}

	c, err := GetConfig()
	if err != nil {
		return "", err
	}

	logPath := filepath.Join(filepath.Dir(c.LogFilePath), "builds", buildId)

	if err := os.MkdirAll(filepath.Dir(logPath), 0755); err != nil {
		return "", fmt.Errorf("failed to create log directory: %w", err)
	}

	if _, err := os.OpenFile(logPath, os.O_CREATE, 0644); err != nil {
		return "", fmt.Errorf("failed to create log file: %w", err)
	}

	return logPath, nil
}
