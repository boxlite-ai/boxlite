//go:build boxlite_runner

package boxlite

import (
	"errors"
	"os"
	"strings"
	"testing"
)

func TestNestedVirtualizationRunnerManagedBridge(t *testing.T) {
	// Managed construction consumes the validated startup snapshot, not ENV.
	t.Setenv("BOXLITE_EXPERIMENTAL", "unknown")
	for _, authorized := range []bool{false, true} {
		var features []string
		if authorized {
			features = []string{"nested-virtualization"}
		}
		rt, err := NewRuntime(WithHomeDir(t.TempDir()), WithRunnerManagedPolicy(features...))
		if err != nil {
			var runtimeErr *Error
			if errors.As(err, &runtimeErr) && runtimeErr.Code == ErrUnsupported && os.Getenv("BOXLITE_REQUIRE_NESTED_RUNTIME_TESTS") != "1" {
				t.Skipf("host virtualization unavailable: %v", err)
			}
			t.Fatal(err)
		}
		defer rt.Close()
		advanced, err := NewAdvancedBoxOptions()
		if err != nil {
			t.Fatal(err)
		}
		defer advanced.Close()
		for _, enabled := range []bool{false, true} {
			if err := advanced.SetRunnerNestedVirtualization(enabled); err != nil {
				t.Fatal(err)
			}
			box, err := rt.Create(t.Context(), "alpine:latest", WithAdvancedOptions(advanced))
			if box != nil {
				box.Close()
			}
			if enabled && !authorized {
				if err == nil || !strings.Contains(err.Error(), "disabled") {
					t.Fatalf("unauthorized decision accepted: %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
		}
		advanced.Close()
		if advanced.SetRunnerNestedVirtualization(true) == nil {
			t.Fatal("closed handle accepted")
		}
	}
	var advanced *AdvancedBoxOptions
	if advanced.SetRunnerNestedVirtualization(true) == nil {
		t.Fatal("nil handle accepted")
	}
}
