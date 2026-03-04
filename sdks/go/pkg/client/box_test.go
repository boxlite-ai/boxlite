package client

import (
	"errors"
	"testing"
	"time"

	"github.com/boxlite-ai/boxlite/sdks/go/internal/binding"
)

func TestBoxExecDelegatesToProvider(t *testing.T) {
	mock := newMockRuntimeProvider()
	mock.AddBox("box-1", "alpine:latest")
	mock.boxes["box-1"].execResult = binding.ExecResult{
		ExitCode: 0,
		Stdout:   []string{"hello from boxlite"},
		Stderr:   nil,
	}

	rt := newRuntimeWith(mock)
	box, err := rt.GetBox(t.Context(), "box-1")
	if err != nil {
		t.Fatal(err)
	}
	if box == nil {
		t.Fatal("expected box, got nil")
	}

	result, err := box.Exec("echo", &ExecOptions{
		Args: []string{"hello", "from", "boxlite"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("expected exit code 0, got %d", result.ExitCode)
	}
	if len(result.Stdout) != 1 || result.Stdout[0] != "hello from boxlite" {
		t.Fatalf("unexpected stdout: %v", result.Stdout)
	}
}

func TestBoxExecNilOpts(t *testing.T) {
	mock := newMockRuntimeProvider()
	mock.AddBox("box-1", "alpine:latest")
	mock.boxes["box-1"].execResult = binding.ExecResult{ExitCode: 42}

	rt := newRuntimeWith(mock)
	box, err := rt.GetBox(t.Context(), "box-1")
	if err != nil {
		t.Fatal(err)
	}

	result, err := box.Exec("exit", nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 42 {
		t.Fatalf("expected exit code 42, got %d", result.ExitCode)
	}
}

func TestBoxExecError(t *testing.T) {
	mock := newMockRuntimeProvider()
	mock.AddBox("box-1", "alpine:latest")
	mock.boxes["box-1"].execErr = errors.New("command not found")

	rt := newRuntimeWith(mock)
	box, err := rt.GetBox(t.Context(), "box-1")
	if err != nil {
		t.Fatal(err)
	}

	_, err = box.Exec("nonexistent", nil)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if err.Error() != "command not found" {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestBoxExecTimeoutConversion(t *testing.T) {
	mock := newMockRuntimeProvider()
	bp := mock.AddBox("box-1", "alpine:latest")

	// Capture the binding opts to verify timeout conversion
	var capturedOpts binding.ExecOptions
	origExec := bp.Exec
	_ = origExec
	// Override with a capturing mock
	capturingProvider := &capturingMockBoxProvider{
		mockBoxProvider: bp,
		capturedOpts:    &capturedOpts,
	}

	rt := &Runtime{runtime: &capturingRuntimeProvider{
		mockRuntimeProvider: mock,
		overrides:           map[string]boxProvider{"box-1": capturingProvider},
	}}

	box, err := rt.GetBox(t.Context(), "box-1")
	if err != nil {
		t.Fatal(err)
	}

	_, err = box.Exec("sleep", &ExecOptions{
		Timeout: 30 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if capturedOpts.TimeoutSec != 30.0 {
		t.Fatalf("expected timeout_secs 30.0, got %f", capturedOpts.TimeoutSec)
	}
}

// capturingMockBoxProvider wraps mockBoxProvider to capture Exec call arguments.
type capturingMockBoxProvider struct {
	*mockBoxProvider
	capturedOpts *binding.ExecOptions
}

func (c *capturingMockBoxProvider) Exec(command string, opts binding.ExecOptions) (binding.ExecResult, error) {
	*c.capturedOpts = opts
	return c.mockBoxProvider.Exec(command, opts)
}

// capturingRuntimeProvider wraps mockRuntimeProvider to return overridden box providers.
type capturingRuntimeProvider struct {
	*mockRuntimeProvider
	overrides map[string]boxProvider
}

func (c *capturingRuntimeProvider) GetBox(idOrName string) (boxProvider, string, error) {
	if bp, ok := c.overrides[idOrName]; ok {
		return bp, idOrName, nil
	}
	return c.mockRuntimeProvider.GetBox(idOrName)
}
