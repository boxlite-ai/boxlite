//go:build boxlite_dev

package boxlite

import (
	"os"
	"testing"

	"github.com/boxlite-ai/runner/pkg/api/dto"
)

func TestNestedAllowlistCapabilityRequiresRuntimeAuthorization(t *testing.T) {
	if (&Client{}).NestedVirtualizationEnabled() {
		t.Fatal("unauthorized client advertised nesting")
	}
}

func TestNestedAllowlistCapabilityUsesValidatedStartupFeatures(t *testing.T) {
	for _, features := range []string{"", "nested-virtualization", " nested-virtualization ,nested-virtualization "} {
		t.Run(features, func(t *testing.T) {
			client, err := NewClient(t.Context(), ClientConfig{HomeDir: t.TempDir(), ExperimentalFeatures: features})
			if err != nil {
				if os.Getenv("BOXLITE_REQUIRE_NESTED_RUNTIME_TESTS") == "1" {
					t.Fatalf("nested runtime qualification requires a usable local runtime: %v", err)
				}
				skipOrFailRuntimeStart(t, err)
			}
			defer client.Close()
			expected := features != "" && nestedVirtualizationAvailable()
			if got := client.NestedVirtualizationEnabled(); got != expected {
				t.Fatalf("startup features %q: got %v", features, got)
			}
			// Reading process ENV per request would change this validated decision.
			if expected {
				t.Setenv("BOXLITE_EXPERIMENTAL", "")
			} else {
				t.Setenv("BOXLITE_EXPERIMENTAL", "nested-virtualization")
			}
			if got := client.NestedVirtualizationEnabled(); got != expected {
				t.Fatal("process ENV changed the startup authorization")
			}
		})
	}
}

func TestNestedAllowlistRecoveryForwardsAttemptPolicy(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		for _, privileged := range []bool{false, true} {
			got := recoverCreateDto("box", dto.RecoverBoxDTO{NestedVirtualization: enabled, Privileged: privileged})
			if got.NestedVirtualization != enabled || got.Privileged != privileged {
				t.Fatalf("recovery changed attempt nesting=%v privilege=%v: %+v", enabled, privileged, got)
			}
		}
	}
}
