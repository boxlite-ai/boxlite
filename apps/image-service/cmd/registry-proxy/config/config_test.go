// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package config

import (
	"maps"
	"os"
	"testing"
)

// An unset environment has to produce a runnable process, because that is what
// a developer and a fresh container both start from.
func TestGetConfigFallsBackToRunnableDefaults(t *testing.T) {
	clearEnvironment(t)

	config, err := GetConfig()
	if err != nil {
		t.Fatalf("GetConfig() failed on an empty environment: %v", err)
	}
	if config.Port != 4100 {
		t.Errorf("Port = %d, want 4100", config.Port)
	}
	// A blob stream is one request, so draining has to outlast the longest pull
	// in flight or a deploy truncates it.
	if config.ShutdownTimeoutSec != 3600 {
		t.Errorf("ShutdownTimeoutSec = %d, want 3600", config.ShutdownTimeoutSec)
	}
}

func TestGetConfigReadsTheEnvironment(t *testing.T) {
	clearEnvironment(t)
	t.Setenv("REGISTRY_PROXY_PORT", "9100")
	t.Setenv("SHUTDOWN_TIMEOUT_SEC", "120")
	t.Setenv("ENVIRONMENT", "dev")

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
}

// A port outside the range binds nothing, so it has to stop the process at
// startup rather than after the platform has already routed traffic at it.
func TestGetConfigRefusesAPortThatCannotBind(t *testing.T) {
	clearEnvironment(t)

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
		"REGISTRY_PROXY_PORT",
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
