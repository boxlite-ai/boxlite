// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package config

import (
	"maps"
	"os"
	"testing"
	"time"
)

// Naming the control plane has to be enough: everything else a developer and a
// fresh container both start from is a default.
func TestGetConfigFallsBackToRunnableDefaults(t *testing.T) {
	clearEnvironment(t)
	t.Setenv("BOXLITE_API_URL", "https://api.example.com")

	config, err := GetConfig()
	if err != nil {
		t.Fatalf("GetConfig() failed with only the control plane named: %v", err)
	}
	if config.Port != 4100 {
		t.Errorf("Port = %d, want 4100", config.Port)
	}
	// A blob stream is one request, so draining has to outlast the longest pull
	// in flight or a deploy truncates it.
	if config.ShutdownTimeoutSec != 3600 {
		t.Errorf("ShutdownTimeoutSec = %d, want 3600", config.ShutdownTimeoutSec)
	}
	// The upstream set has to be closed by default. An empty one would let the
	// request path choose what this process connects to.
	if got := config.UpstreamHosts; len(got) != 2 || got[0] != "ghcr.io" || got[1] != "docker.io" {
		t.Errorf("UpstreamHosts = %v, want the two public registries", got)
	}
	if config.CredentialTTL != 60*time.Second {
		t.Errorf("CredentialTTL = %v, want 60s", config.CredentialTTL)
	}
}

// A runner API key is an opaque column, so a caller can only be checked by
// asking the control plane. Starting without one configured would mean starting
// a process that can refuse every pull and nothing else.
func TestGetConfigRefusesToStartWithoutTheControlPlane(t *testing.T) {
	clearEnvironment(t)

	if config, err := GetConfig(); err == nil {
		t.Fatalf("GetConfig() = %+v, want a refusal without BOXLITE_API_URL", config)
	}

	t.Setenv("BOXLITE_API_URL", "not-a-url")
	if config, err := GetConfig(); err == nil {
		t.Errorf("GetConfig() = %+v, want a refusal for a control plane that is not a URL", config)
	}
}

func TestGetConfigReadsTheEnvironment(t *testing.T) {
	clearEnvironment(t)
	t.Setenv("BOXLITE_API_URL", "https://api.example.com")
	t.Setenv("REGISTRY_PROXY_PORT", "9100")
	t.Setenv("SHUTDOWN_TIMEOUT_SEC", "120")
	t.Setenv("ENVIRONMENT", "dev")
	t.Setenv("REGISTRY_PROXY_UPSTREAM_HOSTS", "ghcr.io,registry.example.com")

	config, err := GetConfig()
	if err != nil {
		t.Fatalf("GetConfig() failed: %v", err)
	}
	if config.Port != 9100 {
		t.Errorf("Port = %d, want 9100", config.Port)
	}
	if config.ShutdownTimeoutSec != 120 {
		t.Errorf("ShutdownTimeoutSec = %d, want 120", config.ShutdownTimeoutSec)
	}
	if config.Environment != "dev" {
		t.Errorf("Environment = %q, want %q", config.Environment, "dev")
	}
	if got := config.UpstreamHosts; len(got) != 2 || got[1] != "registry.example.com" {
		t.Errorf("UpstreamHosts = %v, want the configured pair", got)
	}
}

// A port outside the range binds nothing, so it has to stop the process at
// startup rather than after the platform has already routed traffic at it.
func TestGetConfigRefusesAPortThatCannotBind(t *testing.T) {
	clearEnvironment(t)
	t.Setenv("BOXLITE_API_URL", "https://api.example.com")

	for _, port := range []string{"0", "65536", "-1"} {
		t.Setenv("REGISTRY_PROXY_PORT", port)
		if config, err := GetConfig(); err == nil {
			t.Errorf("REGISTRY_PROXY_PORT=%s was accepted as %d", port, config.Port)
		}
	}
}

func TestGetOtelHeadersSplitsThePairsAndDropsTheRest(t *testing.T) {
	cases := []struct {
		name   string
		header string
		want   map[string]string
	}{
		{"empty", "", map[string]string{}},
		{"one pair", "authorization=Bearer abc", map[string]string{"authorization": "Bearer abc"}},
		{
			name:   "several pairs, spaced",
			header: "authorization=Bearer abc , x-tenant=acme",
			want:   map[string]string{"authorization": "Bearer abc", "x-tenant": "acme"},
		},
		{"an entry that is not a pair", "authorization", map[string]string{}},
		{"a value holding the separator", "authorization=a=b", map[string]string{"authorization": "a=b"}},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := (&Config{OtelHeaders: testCase.header}).GetOtelHeaders()
			if !maps.Equal(got, testCase.want) {
				t.Errorf("GetOtelHeaders(%q) = %v, want %v", testCase.header, got, testCase.want)
			}
		})
	}
}

// envconfig reads the process environment, so a value left over from the shell
// that started the test would decide the result instead of the case. The
// variables are unset rather than emptied: envconfig reads an empty string as a
// value and fails to parse it, which is not what "not configured" means.
func clearEnvironment(t *testing.T) {
	t.Helper()
	for _, name := range []string{
		"BOXLITE_API_URL",
		"REGISTRY_PROXY_PORT",
		"REGISTRY_PROXY_UPSTREAM_HOSTS",
		"REGISTRY_PROXY_CREDENTIAL_TTL",
		"REGISTRY_PROXY_REJECTION_TTL",
		"REGISTRY_PROXY_PULLS_PER_SECOND",
		"REGISTRY_PROXY_PULL_BURST",
		"REGISTRY_PROXY_TRACKED_METERS",
		"REGISTRY_PROXY_UPSTREAM_TIMEOUT",
		"SHUTDOWN_TIMEOUT_SEC",
		"OTEL_LOGGING_ENABLED",
		"OTEL_TRACING_ENABLED",
		"OTEL_EXPORTER_OTLP_ENDPOINT",
		"OTEL_EXPORTER_OTLP_HEADERS",
		"ENVIRONMENT",
	} {
		previous, present := os.LookupEnv(name)
		if present {
			t.Cleanup(func() { os.Setenv(name, previous) })
		}
		os.Unsetenv(name)
	}
}

// A value that does not parse is a typo, and starting with a default in its
// place would run something other than what was written.
func TestGetConfigRefusesAValueThatDoesNotParse(t *testing.T) {
	clearEnvironment(t)
	t.Setenv("BOXLITE_API_URL", "https://api.example.com")
	t.Setenv("REGISTRY_PROXY_PORT", "four-thousand-one-hundred")

	if config, err := GetConfig(); err == nil {
		t.Errorf("REGISTRY_PROXY_PORT that is not a number was accepted as %d", config.Port)
	}
}
