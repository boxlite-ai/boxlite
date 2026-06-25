package config

import "testing"

func TestGettersFallbackToEnvironmentWhenConfigIsUninitialized(t *testing.T) {
	oldConfig := config
	config = nil
	t.Cleanup(func() {
		config = oldConfig
	})

	t.Setenv("CONTAINER_RUNTIME", "containerd")
	t.Setenv("CONTAINER_NETWORK", "boxlite-net")
	t.Setenv("ENVIRONMENT", "development")
	t.Setenv("BUILD_ENGINE", "legacy")

	if got := GetContainerRuntime(); got != "containerd" {
		t.Fatalf("GetContainerRuntime() = %q, want containerd", got)
	}
	if got := GetContainerNetwork(); got != "boxlite-net" {
		t.Fatalf("GetContainerNetwork() = %q, want boxlite-net", got)
	}
	if got := GetEnvironment(); got != "development" {
		t.Fatalf("GetEnvironment() = %q, want development", got)
	}
	if got := GetBuildEngine(); got != "legacy" {
		t.Fatalf("GetBuildEngine() = %q, want legacy", got)
	}
}

func TestGetBuildEngineDefaultsWhenConfigIsUninitialized(t *testing.T) {
	oldConfig := config
	config = nil
	t.Cleanup(func() {
		config = oldConfig
	})

	t.Setenv("BUILD_ENGINE", "")

	if got := GetBuildEngine(); got != "buildkit" {
		t.Fatalf("GetBuildEngine() = %q, want buildkit", got)
	}
}
