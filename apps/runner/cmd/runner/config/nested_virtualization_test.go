package config

import (
	"testing"
)

func TestNestedVirtualizationFromOperatorEnvironment(t *testing.T) {
	previous := config
	config = nil
	t.Cleanup(func() { config = previous })
	t.Setenv("BOXLITE_API_URL", "https://api.example.test")
	t.Setenv("BOXLITE_RUNNER_TOKEN", "test-runner")
	t.Setenv("RUNNER_DOMAIN", "127.0.0.1")
	t.Setenv("BOXLITE_EXPERIMENTAL", "nested-virtualization")
	got, err := GetConfig()
	if err != nil {
		t.Fatal(err)
	}
	if got.ExperimentalFeatures != "nested-virtualization" {
		t.Fatal("runner discarded BOXLITE_EXPERIMENTAL")
	}
}
