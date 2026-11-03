//go:build boxlite_dev

package main

import (
	"errors"
	"io"
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"time"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/cmd/runner/config"
	blclient "github.com/boxlite-ai/runner/pkg/boxlite"
	"github.com/kelseyhightower/envconfig"
)

func TestNestedVirtualizationStartupEnvironmentReachesNativeValidation(t *testing.T) {
	t.Setenv("BOXLITE_EXPERIMENTAL", "nested-virtualization,unknown-startup-feature")
	t.Setenv("BOXLITE_HOME_DIR", t.TempDir())
	// Use the production config type and decoder without changing GetConfig's
	// process-wide cache. Its validation/defaults have their own package tests.
	var cfg config.Config
	if err := envconfig.Process("", &cfg); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client, err := blclient.NewClient(t.Context(), buildBoxliteClientConfig(&cfg, logger))
	if client != nil {
		client.Close()
	}
	var nativeErr *sdk.Error
	if !errors.As(err, &nativeErr) || nativeErr.Code != sdk.ErrConfig || !strings.Contains(err.Error(), "unknown-startup-feature") {
		t.Fatalf("startup must forward the ENV allowlist to native validation before host initialization: %v", err)
	}
}

func TestNestedVirtualizationStartupPreservesClientSettings(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	cfg := config.Config{
		BoxliteHomeDir: "/example/home", ExperimentalFeatures: " nested-virtualization ",
		InsecureRegistries: " registry.one, ,registry.two,registry.one ",
		RegistryProxyHost:  "proxy.example", RegistryProxyUsername: "runner", RegistryProxyPassword: "test-password",
		AWSRegion: "test-region", AWSEndpointUrl: "https://storage.example", AWSAccessKeyId: "test-key", AWSSecretAccessKey: "test-secret",
		VolumeStorageBackend: "gcs", VolumeCleanupInterval: 20 * time.Second,
		VolumeCleanupDryRun: true, VolumeCleanupExclusionPeriod: time.Minute,
	}
	want := blclient.ClientConfig{
		Logger: logger, HomeDir: cfg.BoxliteHomeDir, ExperimentalFeatures: cfg.ExperimentalFeatures,
		InsecureRegistries: []string{"registry.one", "registry.two", "registry.one"},
		RegistryProxy:      blclient.RegistryProxy{Host: cfg.RegistryProxyHost, Username: cfg.RegistryProxyUsername, Password: cfg.RegistryProxyPassword},
		AWSRegion:          cfg.AWSRegion, AWSEndpointUrl: cfg.AWSEndpointUrl, AWSAccessKeyId: cfg.AWSAccessKeyId, AWSSecretAccessKey: cfg.AWSSecretAccessKey,
		VolumeStorageBackend: cfg.VolumeStorageBackend, VolumeCleanupInterval: cfg.VolumeCleanupInterval,
		VolumeCleanupDryRun: cfg.VolumeCleanupDryRun, VolumeCleanupExclusionPeriod: cfg.VolumeCleanupExclusionPeriod,
	}
	if got := buildBoxliteClientConfig(&cfg, logger); !reflect.DeepEqual(got, want) {
		t.Fatal("startup changed existing client configuration or registry normalization")
	}
	if got := buildBoxliteClientConfig(&config.Config{}, nil); !reflect.DeepEqual(got, blclient.ClientConfig{}) {
		t.Fatal("omitted startup settings must retain their zero values")
	}
}
