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

// ============================================================================
// Wire types
// ============================================================================

func TestBuildOptionsJSON(t *testing.T) {
	cfg := &boxConfig{}
	WithCPUs(2)(cfg)
	WithMemory(512)(cfg)
	WithEnv("KEY", "VAL")(cfg)
	WithVolume("/src", "/dst")(cfg)
	WithWorkDir("/work")(cfg)

	wire, err := buildOptionsJSON("alpine:latest", cfg)
	if err != nil {
		t.Fatalf("buildOptionsJSON: %v", err)
	}

	rootfs, ok := wire.Rootfs.(wireRootfsImage)
	if !ok {
		t.Fatalf("Rootfs type: got %T", wire.Rootfs)
	}
	if rootfs.Image != "alpine:latest" {
		t.Errorf("Rootfs.Image: got %q", rootfs.Image)
	}
	if wire.CPUs == nil || *wire.CPUs != 2 {
		t.Error("CPUs not set")
	}
	if wire.MemoryMiB == nil || *wire.MemoryMiB != 512 {
		t.Error("MemoryMiB not set")
	}
	if len(wire.Env) != 1 {
		t.Errorf("Env length: got %d", len(wire.Env))
	}
	if len(wire.Volumes) != 1 {
		t.Errorf("Volumes length: got %d", len(wire.Volumes))
	}
	if wire.WorkDir != "/work" {
		t.Errorf("WorkDir: got %q", wire.WorkDir)
	}
	network, ok := wire.Network.(wireNetworkSpec)
	if !ok {
		t.Fatalf("Network type: got %T", wire.Network)
	}
	if network.Mode != string(NetworkModeEnabled) {
		t.Errorf("Network.Mode: got %q", network.Mode)
	}
	if len(network.AllowNet) != 0 {
		t.Errorf("AllowNet should default to empty, got %v", network.AllowNet)
	}
}

func TestBuildOptionsJSON_Defaults(t *testing.T) {
	cfg := &boxConfig{}
	wire, err := buildOptionsJSON("ubuntu:22.04", cfg)
	if err != nil {
		t.Fatalf("buildOptionsJSON: %v", err)
	}

	if wire.CPUs != nil {
		t.Error("CPUs should be nil by default")
	}
	if wire.MemoryMiB != nil {
		t.Error("MemoryMiB should be nil by default")
	}
	if wire.Env == nil {
		t.Error("Env should be non-nil empty slice")
	}
	if wire.Volumes == nil {
		t.Error("Volumes should be non-nil empty slice")
	}
	if wire.Ports == nil {
		t.Error("Ports should be non-nil empty slice")
	}
	if wire.Secrets == nil {
		t.Error("Secrets should be non-nil empty slice")
	}
	network, ok := wire.Network.(wireNetworkSpec)
	if !ok {
		t.Fatalf("Network type: got %T", wire.Network)
	}
	if network.Mode != string(NetworkModeEnabled) {
		t.Errorf("Network.Mode: got %q", network.Mode)
	}
}

func TestBoxInfoWire_ToBoxInfo(t *testing.T) {
	pid := 42
	info := boxInfoWire{
		ID:   "abc-123",
		Name: "test-box",
		State: wireStateInfo{
			Status:  "running",
			Running: true,
			PID:     &pid,
		},
		Image:     "alpine:latest",
		CPUs:      2,
		MemoryMiB: 512,
	}

	boxInfo := info.toBoxInfo()
	if boxInfo.ID != "abc-123" {
		t.Errorf("ID: got %q", boxInfo.ID)
	}
	if boxInfo.State != StateRunning {
		t.Errorf("State: got %q", boxInfo.State)
	}
	if !boxInfo.Running {
		t.Error("Running should be true")
	}
	if boxInfo.PID != 42 {
		t.Errorf("PID: got %d", boxInfo.PID)
	}
	if boxInfo.CPUs != 2 {
		t.Errorf("CPUs: got %d", boxInfo.CPUs)
	}
	if boxInfo.Image != "alpine:latest" {
		t.Errorf("Image: got %q", boxInfo.Image)
	}
}

func TestBoxInfoWire_ToBoxInfo_NilPID(t *testing.T) {
	info := boxInfoWire{
		State: wireStateInfo{
			Status:  "configured",
			Running: false,
			PID:     nil,
		},
	}

	boxInfo := info.toBoxInfo()
	if boxInfo.PID != 0 {
		t.Errorf("PID: got %d, want 0", boxInfo.PID)
	}
	if boxInfo.Running {
		t.Error("Running should be false")
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

func TestBuildOptionsJSON_AutoRemoveDetach(t *testing.T) {
	cfg := &boxConfig{}
	WithAutoRemove(false)(cfg)
	WithDetach(true)(cfg)

	wire, err := buildOptionsJSON("alpine:latest", cfg)
	if err != nil {
		t.Fatalf("buildOptionsJSON: %v", err)
	}
	if wire.AutoRemove == nil || *wire.AutoRemove != false {
		t.Error("AutoRemove should be false in wire")
	}
	if wire.Detach == nil || *wire.Detach != true {
		t.Error("Detach should be true in wire")
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

func TestBuildOptionsJSON_AllowNetAndSecrets(t *testing.T) {
	cfg := &boxConfig{}
	WithNetwork(NetworkSpec{
		Mode:     NetworkModeEnabled,
		AllowNet: []string{"example.com", "10.0.0.0/8"},
	})(cfg)
	WithSecret(Secret{
		Name:  "openai",
		Value: "sk-secret",
		Hosts: []string{"api.openai.com"},
	})(cfg)

	wire, err := buildOptionsJSON("python:slim", cfg)
	if err != nil {
		t.Fatalf("buildOptionsJSON: %v", err)
	}

	network, ok := wire.Network.(wireNetworkSpec)
	if !ok {
		t.Fatalf("Network type: got %T", wire.Network)
	}
	if network.Mode != string(NetworkModeEnabled) {
		t.Errorf("Network.Mode: got %q", network.Mode)
	}
	if len(network.AllowNet) != 2 {
		t.Fatalf("AllowNet length: got %d", len(network.AllowNet))
	}
	if network.AllowNet[0] != "example.com" {
		t.Errorf("AllowNet[0]: got %q", network.AllowNet[0])
	}
	if len(wire.Secrets) != 1 {
		t.Fatalf("Secrets length: got %d", len(wire.Secrets))
	}
	if wire.Secrets[0].Placeholder != "<BOXLITE_SECRET:openai>" {
		t.Errorf("Placeholder: got %q", wire.Secrets[0].Placeholder)
	}
}

func TestBuildOptionsJSON_DisabledNetwork(t *testing.T) {
	cfg := &boxConfig{}
	WithNetwork(NetworkSpec{Mode: NetworkModeDisabled})(cfg)

	wire, err := buildOptionsJSON("alpine:latest", cfg)
	if err != nil {
		t.Fatalf("buildOptionsJSON: %v", err)
	}
	network, ok := wire.Network.(wireNetworkSpec)
	if !ok {
		t.Fatalf("Network type: got %T", wire.Network)
	}
	if network.Mode != string(NetworkModeDisabled) {
		t.Errorf("Network.Mode: got %q", network.Mode)
	}
	if len(network.AllowNet) != 0 {
		t.Errorf("Network.AllowNet: got %v", network.AllowNet)
	}
}

func TestBuildOptionsJSON_RejectsAllowNetWithDisabledMode(t *testing.T) {
	cfg := &boxConfig{}
	WithNetwork(NetworkSpec{
		Mode:     NetworkModeDisabled,
		AllowNet: []string{"example.com"},
	})(cfg)

	_, err := buildOptionsJSON("alpine:latest", cfg)
	if err == nil {
		t.Fatal("expected error for disabled network with allowlist")
	}
	if err.Error() != "network.mode=\"disabled\" is incompatible with allow_net" {
		t.Fatalf("unexpected error: %v", err)
	}
}
