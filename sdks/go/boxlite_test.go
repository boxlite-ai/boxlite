package boxlite

import (
	"errors"
	"testing"
)

// ============================================================================
// Error types
// ============================================================================

func TestError_Error(t *testing.T) {
	e := &Error{Code: ErrNotFound, Message: "box not found"}
	got := e.Error()
	if got != "boxlite: box not found (code=2)" {
		t.Errorf("Error(): got %q", got)
	}
}

func TestIsNotFound(t *testing.T) {
	err := &Error{Code: ErrNotFound, Message: "missing"}
	if !IsNotFound(err) {
		t.Error("expected IsNotFound to return true")
	}
	if IsNotFound(errors.New("other")) {
		t.Error("expected IsNotFound to return false for non-Error")
	}
	if IsNotFound(&Error{Code: ErrInternal, Message: "internal"}) {
		t.Error("expected IsNotFound to return false for different code")
	}
}

func TestIsAlreadyExists(t *testing.T) {
	err := &Error{Code: ErrAlreadyExists, Message: "exists"}
	if !IsAlreadyExists(err) {
		t.Error("expected IsAlreadyExists to return true")
	}
	if IsAlreadyExists(errors.New("other")) {
		t.Error("expected IsAlreadyExists to return false for non-Error")
	}
}

func TestIsInvalidState(t *testing.T) {
	err := &Error{Code: ErrInvalidState, Message: "bad state"}
	if !IsInvalidState(err) {
		t.Error("expected IsInvalidState to return true")
	}
	if IsInvalidState(errors.New("other")) {
		t.Error("expected IsInvalidState to return false for non-Error")
	}
}

func TestIsStopped(t *testing.T) {
	err := &Error{Code: ErrStopped, Message: "runtime shut down"}
	if !IsStopped(err) {
		t.Error("expected IsStopped to return true")
	}
	if IsStopped(errors.New("other")) {
		t.Error("expected IsStopped to return false for non-Error")
	}
}

func TestError_Unwrap(t *testing.T) {
	err := &Error{Code: ErrNotFound, Message: "test"}
	var target *Error
	if !errors.As(err, &target) {
		t.Error("errors.As should match *Error")
	}
	if target.Code != ErrNotFound {
		t.Errorf("Code: got %d, want %d", target.Code, ErrNotFound)
	}
}

// ============================================================================
// Options
// ============================================================================

func TestBoxOptions(t *testing.T) {
	cfg := &boxConfig{}
	WithName("test-box")(cfg)
	WithCPUs(4)(cfg)
	WithMemory(1024)(cfg)
	WithEnv("FOO", "bar")(cfg)
	WithVolume("/host", "/guest")(cfg)
	WithVolumeReadOnly("/ro-host", "/ro-guest")(cfg)
	WithWorkDir("/app")(cfg)
	WithEntrypoint("/bin/sh")(cfg)
	WithCmd("-c", "echo hi")(cfg)
	WithNetwork(NetworkSpec{
		Mode:     NetworkModeEnabled,
		AllowNet: []string{"example.com", "*.openai.com"},
	})(cfg)
	WithSecret(Secret{Name: "openai", Value: "sk-test"})(cfg)

	if cfg.name != "test-box" {
		t.Errorf("name: got %q", cfg.name)
	}
	if cfg.cpus != 4 {
		t.Errorf("cpus: got %d", cfg.cpus)
	}
	if cfg.memoryMiB != 1024 {
		t.Errorf("memoryMiB: got %d", cfg.memoryMiB)
	}
	if len(cfg.env) != 1 || cfg.env[0] != [2]string{"FOO", "bar"} {
		t.Errorf("env: got %v", cfg.env)
	}
	if len(cfg.volumes) != 2 {
		t.Fatalf("volumes: got %d", len(cfg.volumes))
	}
	if cfg.volumes[0].readOnly {
		t.Error("first volume should be read-write")
	}
	if !cfg.volumes[1].readOnly {
		t.Error("second volume should be read-only")
	}
	if cfg.workDir != "/app" {
		t.Errorf("workDir: got %q", cfg.workDir)
	}
	if cfg.network == nil {
		t.Fatal("network should be set")
	}
	if cfg.network.Mode != NetworkModeEnabled {
		t.Errorf("network.Mode: got %q", cfg.network.Mode)
	}
	if len(cfg.network.AllowNet) != 2 {
		t.Errorf("network.AllowNet: got %v", cfg.network.AllowNet)
	}
	if len(cfg.secrets) != 1 {
		t.Fatalf("secrets: got %d", len(cfg.secrets))
	}
	if cfg.secrets[0].Name != "openai" {
		t.Errorf("secret name: got %q", cfg.secrets[0].Name)
	}
}

func TestRuntimeOptions(t *testing.T) {
	cfg := &runtimeConfig{}
	WithHomeDir("/custom")(cfg)
	WithRegistries("ghcr.io", "docker.io")(cfg)

	if cfg.homeDir != "/custom" {
		t.Errorf("homeDir: got %q", cfg.homeDir)
	}
	if len(cfg.registries) != 2 {
		t.Errorf("registries: got %v", cfg.registries)
	}
}

func TestBuildCOptions_MissingImageAndPath(t *testing.T) {
	cfg := &boxConfig{}
	_, err := buildCOptions("", cfg)
	if err == nil {
		t.Fatal("expected error when image is empty and WithRootfsPath is not set")
	}
}

// ============================================================================
// State constants
// ============================================================================

func TestStateConstants(t *testing.T) {
	tests := []struct {
		state State
		want  string
	}{
		{StateConfigured, "configured"},
		{StateRunning, "running"},
		{StateStopping, "stopping"},
		{StateStopped, "stopped"},
	}
	for _, tc := range tests {
		if string(tc.state) != tc.want {
			t.Errorf("State %v: got %q, want %q", tc.state, string(tc.state), tc.want)
		}
	}
}

// ============================================================================
// AutoRemove / Detach options
// ============================================================================

func TestWithAutoRemove(t *testing.T) {
	cfg := &boxConfig{}
	WithAutoRemove(false)(cfg)
	if cfg.autoRemove == nil || *cfg.autoRemove != false {
		t.Error("autoRemove should be false")
	}
}

func TestWithDetach(t *testing.T) {
	cfg := &boxConfig{}
	WithDetach(true)(cfg)
	if cfg.detach == nil || *cfg.detach != true {
		t.Error("detach should be true")
	}
}

func TestWithNetwork(t *testing.T) {
	cfg := &boxConfig{}
	WithNetwork(NetworkSpec{
		Mode:     NetworkModeDisabled,
		AllowNet: []string{},
	})(cfg)

	if cfg.network == nil {
		t.Fatal("network should be set")
	}
	if cfg.network.Mode != NetworkModeDisabled {
		t.Errorf("network.Mode: got %q", cfg.network.Mode)
	}
	if len(cfg.network.AllowNet) != 0 {
		t.Errorf("network.AllowNet: got %v", cfg.network.AllowNet)
	}
}

func TestBuildCOptions_RejectsAllowNetWithDisabledMode(t *testing.T) {
	cfg := &boxConfig{}
	WithNetwork(NetworkSpec{
		Mode:     NetworkModeDisabled,
		AllowNet: []string{"example.com"},
	})(cfg)

	_, err := buildCOptions("alpine:latest", cfg)
	if err == nil {
		t.Fatal("expected error for disabled network with allowlist")
	}
	if err.Error() != "network.mode=\"disabled\" is incompatible with allow_net" {
		t.Fatalf("unexpected error: %v", err)
	}
}
