//go:build boxlite_dev

package boxlite

import (
	"context"
	"strings"
	"testing"
)

// TestIntegrationAdvancedOptionsSecurityDisabled boots a box whose sandbox is
// toggled off through the advanced-options layer (NewAdvancedBoxOptions ->
// SetSecurityEnabled(false) -> WithAdvancedOptions -> boxlite_options_set_advanced),
// exercising the full public API path end to end and confirming the box runs.
// The disabled profile is the point of this test (verify the opt-out path),
// not an environment shortcut.
func TestIntegrationAdvancedOptionsSecurityDisabled(t *testing.T) {
	rt := newTestRuntime(t)

	adv, err := NewAdvancedBoxOptions()
	if err != nil {
		t.Fatalf("NewAdvancedBoxOptions: %v", err)
	}
	defer adv.Close()
	adv.SetSecurityEnabled(false)

	box := createStartedBox(t, rt, "alpine:latest", WithAdvancedOptions(adv))

	result, err := box.Exec(context.Background(), "echo", "advanced-ok")
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("unexpected exit code: %d stderr=%q", result.ExitCode, result.Stderr)
	}
	if !strings.Contains(result.Stdout, "advanced-ok") {
		t.Fatalf("expected command output through advanced-options box, got %q", result.Stdout)
	}
}
