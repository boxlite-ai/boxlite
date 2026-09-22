// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package config

import (
	"os"
	"testing"
)

func TestDefaultMaxConcurrentJobs(t *testing.T) {
	previous := config
	config = nil
	t.Cleanup(func() { config = previous })
	t.Setenv("BOXLITE_API_URL", "http://runner.invalid")
	t.Setenv("BOXLITE_RUNNER_TOKEN", "YOUR_API_KEY")
	t.Setenv("RUNNER_DOMAIN", "localhost")
	t.Setenv("MAX_CONCURRENT_JOBS", "")
	if err := os.Unsetenv("MAX_CONCURRENT_JOBS"); err != nil {
		t.Fatal(err)
	}
	cfg, err := GetConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MaxConcurrentJobs != 50 {
		t.Fatalf("default job concurrency = %d, want 50", cfg.MaxConcurrentJobs)
	}
}

func TestConfiguredMaxConcurrentJobs(t *testing.T) {
	for _, test := range []struct {
		value string
		want  int
	}{{"100", 100}, {"1", 1}, {"0", 0}, {"-1", 0}, {"invalid", 0}} {
		t.Run(test.value, func(t *testing.T) {
			previous := config
			config = nil
			t.Cleanup(func() { config = previous })
			t.Setenv("BOXLITE_API_URL", "http://runner.invalid")
			t.Setenv("BOXLITE_RUNNER_TOKEN", "YOUR_API_KEY")
			t.Setenv("RUNNER_DOMAIN", "localhost")
			t.Setenv("MAX_CONCURRENT_JOBS", test.value)
			cfg, err := GetConfig()
			if test.want == 0 {
				if err == nil {
					t.Fatal("accepted invalid limit")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if cfg.MaxConcurrentJobs != test.want {
				t.Fatalf("concurrency=%d want=%d", cfg.MaxConcurrentJobs, test.want)
			}
		})
	}
}
