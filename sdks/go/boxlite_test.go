package boxlite

import (
	"errors"
	"testing"
)

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
}

func TestIsInvalidState(t *testing.T) {
	err := &Error{Code: ErrInvalidState, Message: "bad state"}
	if !IsInvalidState(err) {
		t.Error("expected IsInvalidState to return true")
	}
}

func TestVersion(t *testing.T) {
	v := Version()
	if v == "" {
		t.Error("Version should not be empty")
	}
	t.Logf("Version: %s", v)
}

func TestNetworkSpec(t *testing.T) {
	enabled := NetworkEnabled()
	if enabled.disabled {
		t.Error("NetworkEnabled should not be disabled")
	}

	disabled := NetworkDisabled()
	if !disabled.disabled {
		t.Error("NetworkDisabled should be disabled")
	}

	allowList := NetworkEnabledWithAllowList("example.com", "10.0.0.0/8")
	if allowList.disabled {
		t.Error("NetworkEnabledWithAllowList should not be disabled")
	}
	if len(allowList.allowNet) != 2 {
		t.Errorf("expected 2 hosts, got %d", len(allowList.allowNet))
	}
}

func TestBoxOptions(t *testing.T) {
	cfg := &boxConfig{}
	WithName("test")(cfg)
	WithCPUs(2)(cfg)
	WithMemory(512)(cfg)
	WithDiskSize(10)(cfg)
	WithUser("ubuntu")(cfg)
	WithWorkDir("/app")(cfg)
	WithEnv("FOO", "bar")(cfg)
	WithVolume("/host", "/guest")(cfg)
	WithPort(8080, 0)(cfg)
	WithNetwork(NetworkEnabled())(cfg)
	WithAutoRemove(false)(cfg)
	WithDetach(true)(cfg)

	if cfg.name != "test" {
		t.Errorf("name: got %q", cfg.name)
	}
	if cfg.cpus != 2 {
		t.Errorf("cpus: got %d", cfg.cpus)
	}
	if cfg.memoryMiB != 512 {
		t.Errorf("memoryMiB: got %d", cfg.memoryMiB)
	}
	if cfg.diskSizeGB != 10 {
		t.Errorf("diskSizeGB: got %d", cfg.diskSizeGB)
	}
	if cfg.user != "ubuntu" {
		t.Errorf("user: got %q", cfg.user)
	}
	if len(cfg.env) != 1 {
		t.Errorf("env: got %d", len(cfg.env))
	}
	if len(cfg.volumes) != 1 {
		t.Errorf("volumes: got %d", len(cfg.volumes))
	}
	if len(cfg.ports) != 1 {
		t.Errorf("ports: got %d", len(cfg.ports))
	}
	if cfg.network == nil || cfg.network.disabled {
		t.Error("network should be enabled")
	}
	if cfg.autoRemove == nil || *cfg.autoRemove {
		t.Error("autoRemove should be false")
	}
	if cfg.detach == nil || !*cfg.detach {
		t.Error("detach should be true")
	}
}
