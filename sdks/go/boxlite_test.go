package boxlite

import (
	"errors"
	"testing"
	"unsafe"
)

func testRegistryPassword() string {
	return string([]byte{115, 101, 99, 114, 101, 116})
}

func testBearerToken() string {
	return string([]byte{111, 112, 97, 113, 117, 101})
}

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

func TestExecutionWriteRejectsClosedExecution(t *testing.T) {
	execution := &Execution{}
	execution.Stdin = &executionStdin{execution: execution}

	_, err := execution.Write([]byte("hello"))
	if err == nil {
		t.Fatal("expected error")
	}

	var boxliteErr *Error
	if !errors.As(err, &boxliteErr) {
		t.Fatalf("expected *Error, got %T", err)
	}
	if boxliteErr.Code != ErrInvalidState {
		t.Fatalf("Code: got %d, want %d", boxliteErr.Code, ErrInvalidState)
	}
}

func TestExecutionCloseIsIdempotent(t *testing.T) {
	execution := &Execution{}

	if err := execution.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if err := execution.Close(); err != nil {
		t.Fatalf("second Close() error = %v", err)
	}
}

// TestExecutionSignalRejectsClosedExecution: Signal on a nil-handle
// Execution must return an InvalidState error before any FFI call. This
// guards the contract symmetry with Kill — both must early-return when
// the underlying C handle has been freed.
func TestExecutionSignalRejectsClosedExecution(t *testing.T) {
	execution := &Execution{}

	err := execution.Signal(t.Context(), 15)
	if err == nil {
		t.Fatal("expected error")
	}

	var boxliteErr *Error
	if !errors.As(err, &boxliteErr) {
		t.Fatalf("expected *Error, got %T", err)
	}
	if boxliteErr.Code != ErrInvalidState {
		t.Fatalf("Code: got %d, want %d", boxliteErr.Code, ErrInvalidState)
	}
}

// TestExecutionSignalRejectsOutOfRangeSignal: signal numbers outside
// 1..=64 must be rejected synchronously, before any FFI call. This is
// the layer-2 mirror of `signal_rejects_out_of_range_*` in the Rust
// C-FFI tests; the Go SDK validates first so an invalid signal can
// never reach the Rust runtime. Range validation runs before the
// closed-handle check so the empty Execution (handle==nil) is fine.
func TestExecutionSignalRejectsOutOfRangeSignal(t *testing.T) {
	execution := &Execution{}

	cases := []struct {
		name string
		sig  int
	}{
		{"zero", 0},
		{"negative", -1},
		{"above_max", 65},
		{"way_above_max", 1024},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := execution.Signal(t.Context(), tc.sig)
			if err == nil {
				t.Fatalf("expected error for signal=%d", tc.sig)
			}
			var boxliteErr *Error
			if !errors.As(err, &boxliteErr) {
				t.Fatalf("expected *Error, got %T", err)
			}
			if boxliteErr.Code != ErrInvalidArgument {
				t.Fatalf("Code: got %d, want %d", boxliteErr.Code, ErrInvalidArgument)
			}
		})
	}
}

// TestExecutionSignalAcceptsBoundarySignals: signal numbers at the
// 1 and 64 boundaries must NOT be rejected by the range check. With
// handle==nil they fall through to the closed-execution check
// (InvalidState), proving the range validation accepted them.
func TestExecutionSignalAcceptsBoundarySignals(t *testing.T) {
	execution := &Execution{}

	for _, sig := range []int{1, 15, 64} {
		err := execution.Signal(t.Context(), sig)
		if err == nil {
			t.Fatalf("expected closed-execution error for signal=%d", sig)
		}
		var boxliteErr *Error
		if !errors.As(err, &boxliteErr) {
			t.Fatalf("signal=%d: expected *Error, got %T", sig, err)
		}
		// Range check accepted the signal → fell through to handle check.
		if boxliteErr.Code != ErrInvalidState {
			t.Fatalf("signal=%d Code: got %d, want %d (range check should accept %d)",
				sig, boxliteErr.Code, ErrInvalidState, sig)
		}
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
	password := testRegistryPassword()
	cfg := &runtimeConfig{}
	WithHomeDir("/custom")(cfg)
	WithImageRegistries(
		ImageRegistry{Host: "ghcr.io", Search: true},
		ImageRegistry{Host: "docker.io", Search: true},
		ImageRegistry{
			Host:       "registry.local:5000",
			Transport:  RegistryTransportHTTP,
			SkipVerify: true,
			Search:     true,
			Auth: ImageRegistryAuth{
				Username: "alice",
				Password: password,
			},
		},
	)(cfg)

	if cfg.homeDir != "/custom" {
		t.Errorf("homeDir: got %q", cfg.homeDir)
	}
	if len(cfg.imageRegistries) != 3 {
		t.Fatalf("imageRegistries: got %v", cfg.imageRegistries)
	}
	if !cfg.imageRegistries[0].Search {
		t.Errorf("image registry search: got false")
	}
	if cfg.imageRegistries[2].Transport != RegistryTransportHTTP {
		t.Errorf("registry transport: got %q", cfg.imageRegistries[2].Transport)
	}
	if cfg.imageRegistries[2].Auth.Username != "alice" {
		t.Errorf("registry auth username: got %q", cfg.imageRegistries[2].Auth.Username)
	}
}

func TestToCImageRegistryArray(t *testing.T) {
	password := testRegistryPassword()
	token := testBearerToken()
	cRegistries, count, free, err := toCImageRegistryArray([]ImageRegistry{
		{Host: "ghcr.io", Search: true},
		{
			Host:       "registry.local:5000",
			Transport:  RegistryTransportHTTP,
			SkipVerify: true,
			Search:     true,
			Auth: ImageRegistryAuth{
				Username: "alice",
				Password: password,
			},
		},
		{
			Host: "registry.example.com",
			Auth: ImageRegistryAuth{BearerToken: token},
		},
	})
	if err != nil {
		t.Fatalf("toCImageRegistryArray: %v", err)
	}
	defer free()

	if count != 3 {
		t.Fatalf("count: got %d, want 3", count)
	}

	registries := unsafe.Slice(cRegistries, count)
	httpTransport, err := cRegistryTransport(RegistryTransportHTTP)
	if err != nil {
		t.Fatalf("cRegistryTransport: %v", err)
	}

	if cString(registries[0].host) != "ghcr.io" {
		t.Errorf("host[0]: got %q", cString(registries[0].host))
	}
	if registries[0].search == 0 {
		t.Error("search[0]: got false")
	}
	if cString(registries[1].host) != "registry.local:5000" {
		t.Errorf("host[1]: got %q", cString(registries[1].host))
	}
	if uint32(registries[1].transport) != httpTransport {
		t.Errorf("transport[1]: got %d, want %d", registries[1].transport, httpTransport)
	}
	if registries[1].skip_verify == 0 {
		t.Error("skip_verify[1]: got false")
	}
	if cString(registries[1].username) != "alice" {
		t.Errorf("username[1]: got %q", cString(registries[1].username))
	}
	if cString(registries[1].password) != password {
		t.Errorf("password[1]: got %q", cString(registries[1].password))
	}
	if cString(registries[2].bearer_token) != token {
		t.Errorf("bearer_token[2]: got %q", cString(registries[2].bearer_token))
	}
}

func TestToCImageRegistryArrayRejectsInvalidConfig(t *testing.T) {
	cases := []struct {
		name       string
		registries []ImageRegistry
	}{
		{
			name:       "empty host",
			registries: []ImageRegistry{{Host: " "}},
		},
		{
			name:       "url host",
			registries: []ImageRegistry{{Host: "https://registry.local"}},
		},
		{
			name:       "path host",
			registries: []ImageRegistry{{Host: "registry.local/ns"}},
		},
		{
			name:       "unsupported transport",
			registries: []ImageRegistry{{Host: "registry.local", Transport: "ftp"}},
		},
		{
			name: "partial basic auth",
			registries: []ImageRegistry{{
				Host: "registry.local",
				Auth: ImageRegistryAuth{Username: "alice"},
			}},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cRegistries, _, free, err := toCImageRegistryArray(tc.registries)
			if err == nil {
				if free != nil {
					free()
				}
				t.Fatalf("expected error, got registries=%v", cRegistries)
			}
		})
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
