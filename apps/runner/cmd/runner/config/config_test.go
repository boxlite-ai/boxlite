// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package config

import (
	"os"
	"strings"
	"testing"
)

func resetConfigForTest(t *testing.T) {
	t.Helper()
	previous := config
	config = nil
	t.Cleanup(func() { config = previous })
}

func TestGetConfigRequiresVolumeBucketPrefix(t *testing.T) {
	resetConfigForTest(t)

	previous, existed := os.LookupEnv("VOLUME_BUCKET_PREFIX")
	if err := os.Unsetenv("VOLUME_BUCKET_PREFIX"); err != nil {
		t.Fatalf("unset VOLUME_BUCKET_PREFIX: %v", err)
	}
	t.Cleanup(func() {
		if existed {
			_ = os.Setenv("VOLUME_BUCKET_PREFIX", previous)
		} else {
			_ = os.Unsetenv("VOLUME_BUCKET_PREFIX")
		}
	})

	_, err := GetConfig()
	if err == nil || !strings.Contains(err.Error(), "VOLUME_BUCKET_PREFIX") {
		t.Fatalf("GetConfig() error = %v, want missing VOLUME_BUCKET_PREFIX error", err)
	}
}

func TestGetConfigLoadsVolumeBucketPrefix(t *testing.T) {
	resetConfigForTest(t)
	t.Setenv("VOLUME_BUCKET_PREFIX", "boxlite-test-volume-")
	t.Setenv("BOXLITE_API_URL", "http://localhost:3000/api")
	t.Setenv("BOXLITE_RUNNER_TOKEN", "test-token")

	cfg, err := GetConfig()
	if err != nil {
		t.Fatalf("GetConfig(): %v", err)
	}
	if cfg.VolumeBucketPrefix != "boxlite-test-volume-" {
		t.Fatalf("VolumeBucketPrefix = %q, want %q", cfg.VolumeBucketPrefix, "boxlite-test-volume-")
	}
}
