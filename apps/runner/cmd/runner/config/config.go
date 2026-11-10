// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package config

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
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
	VolumeStorageBackend               string        `envconfig:"VOLUME_STORAGE_BACKEND" default:"s3" validate:"oneof=s3 gcs"`
	ResourceLimitsDisabled             bool          `envconfig:"RESOURCE_LIMITS_DISABLED"`
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
	KernelPath                         string        `envconfig:"BOXLITE_KERNEL_PATH"`
	ExperimentalFeatures               string        `envconfig:"BOXLITE_EXPERIMENTAL"`
	InsecureRegistries                 string        `envconfig:"INSECURE_REGISTRIES"`
	RegistryProxyHost                  string        `envconfig:"REGISTRY_PROXY_HOST"`
	RegistryProxyUsername              string        `envconfig:"REGISTRY_PROXY_USERNAME"`
	RegistryProxyPassword              string        `envconfig:"REGISTRY_PROXY_PASSWORD"`
	MigrateWorkDir                     string        `envconfig:"MIGRATE_WORK_DIR"`
	// Data disk identity injected by infra on GCP hosts (hyperdisk LLD §4.2).
	// When all three are set, the healthcheck reports them as a dataDiskRef;
	// if any is missing, the ref is omitted entirely.
	GCPProjectID string `envconfig:"GCP_PROJECT_ID"`
	GCPZone      string `envconfig:"GCP_ZONE"`
	// RunnerDataDiskName is the GCP disk resource name (the name part of
	// projects/…/zones/…/disks/<name>) as provisioned by infra; the API's
	// disk-expansion controller targets this exact resource.
	RunnerDataDiskName string `envconfig:"RUNNER_DATA_DISK_NAME"`
	// RunnerDataDiskType names the backend behind the identity
	// (hyperdisk_balanced today; a Filestore share would report differently).
	// Optional: the API assumes hyperdisk_balanced when absent, matching
	// everything infra provisions today.
	RunnerDataDiskType string `envconfig:"RUNNER_DATA_DISK_TYPE"`
	// DataDiskDevice overrides the block device path the resize ticker reads
	// (default /dev/disk/by-id/google-boxlite-data). Test/local-only: prod
	// never sets it.
	DataDiskDevice string `envconfig:"RUNNER_DATA_DISK_DEVICE"`

	FilestoreInstances                 string        `envconfig:"FILESTORE_INSTANCES"`

	// Parsed from FilestoreInstances during GetConfig; empty when the variable
	// is unset. Kept off envconfig: envconfig cannot populate a struct slice,
	// which is why the raw JSON arrives as a plain string in the first place.
	filestoreInstances []FilestoreInstance
}

// FilestoreInstance is one managed GCP Filestore NFS instance the runner may
// mount on demand. The runner never creates or deletes instances (the operator
// provisions them); this is only the declarative list of what it may consume.
// A box's volume reference carries the Name only — the address is resolved
// here at mount time, so an instance that is recreated under the same name
// needs no change to historical boxes.
type FilestoreInstance struct {
	Name         string   `json:"name"`
	Server       string   `json:"server"`
	Export       string   `json:"export"`
	MountOptions []string `json:"mountOptions,omitempty"`
}

// filestoreInstanceNamePattern bounds what a Filestore instance logical name
// may look like. The name is joined into host mount paths
// (/mnt/boxlite-filestore-<name>), so this rejects anything that could carry a
// path separator or relative component into one. The API enforces the same
// pattern on the box volume reference; the two must stay in agreement.
const filestoreInstanceNamePattern = `^[a-z0-9][a-z0-9-]{0,62}$`

// ParseFilestoreInstances decodes and validates the FILESTORE_INSTANCES JSON
// array. An unset or empty value means "this runner consumes no Filestore
// instances" and is not an error — a runner that never receives a filestore
// volume reference never consults the registry.
//
// Every failure below is a deployment mistake that would otherwise surface as
// a mystery at first box create: malformed JSON, a duplicate name (the mount
// point is keyed by name, so duplicates would alias two instances onto one
// path), or an entry that cannot produce a usable mount. All of them are
// rejected here so the runner refuses to start rather than half-serve.
func ParseFilestoreInstances(raw string) ([]FilestoreInstance, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}

	var instances []FilestoreInstance
	if err := json.Unmarshal([]byte(raw), &instances); err != nil {
		return nil, fmt.Errorf("FILESTORE_INSTANCES is not a valid JSON array of instances: %w", err)
	}

	nameRe := regexp.MustCompile(filestoreInstanceNamePattern)
	seen := make(map[string]bool, len(instances))
	for _, inst := range instances {
		if !nameRe.MatchString(inst.Name) {
			return nil, fmt.Errorf("FILESTORE_INSTANCES entry has an invalid name %q (must match %s)", inst.Name, filestoreInstanceNamePattern)
		}
		if seen[inst.Name] {
			return nil, fmt.Errorf("FILESTORE_INSTANCES defines instance %q more than once", inst.Name)
		}
		seen[inst.Name] = true
		if inst.Server == "" {
			return nil, fmt.Errorf("FILESTORE_INSTANCES entry %q has no server", inst.Name)
		}
		if inst.Export == "" {
			return nil, fmt.Errorf("FILESTORE_INSTANCES entry %q has no export", inst.Name)
		}
		// The protocol version and retry posture are design-pinned (NFSv4.1,
		// hard): mount(8) lets a later duplicate option override an earlier
		// one, so a registry entry carrying them would silently override the
		// pinned argv. Everything else may be appended via mountOptions.
		for _, opt := range inst.MountOptions {
			lower := strings.ToLower(strings.TrimSpace(opt))
			for _, pinned := range []string{"vers", "nfsvers", "proto", "soft", "hard"} {
				if strings.HasPrefix(lower, pinned) {
					return nil, fmt.Errorf("FILESTORE_INSTANCES entry %q sets pinned mount option %q (protocol is NFSv4.1, retry posture is hard; mountOptions may not override them)", inst.Name, opt)
				}
			}
		}
	}

	return instances, nil
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

	defaultRegistryProxyLogin(config)

	filestoreInstances, err := ParseFilestoreInstances(config.FilestoreInstances)
	if err != nil {
		return nil, err
	}
	config.filestoreInstances = filestoreInstances

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

// defaultRegistryProxyLogin fills in the runner's login to the registry proxy.
//
// The proxy checks the password against the control plane as a runner key, so
// the one that works is this runner's own. Taking it from ApiToken rather than
// asking a deployment to write it twice means a rotated runner token cannot
// leave the proxy login behind. The username is not checked; "runner" is what
// the local stack has always sent.
func defaultRegistryProxyLogin(config *Config) {
	if config.RegistryProxyHost == "" {
		return
	}
	if config.RegistryProxyPassword == "" {
		config.RegistryProxyPassword = config.ApiToken
	}
	if config.RegistryProxyUsername == "" {
		config.RegistryProxyUsername = "runner"
	}
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

func GetEnvironment() string {
	return config.Environment
}

// GetFilestoreInstances returns the registry parsed at startup. The slice is
// nil when FILESTORE_INSTANCES is unset — a runner in that state fails any box
// that references a Filestore instance, which is the honest outcome for a
// deployment that never opted in.
func (c *Config) GetFilestoreInstances() []FilestoreInstance {
	return c.filestoreInstances
}
