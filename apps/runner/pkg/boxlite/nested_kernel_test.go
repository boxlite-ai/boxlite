//go:build boxlite_dev

package boxlite

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"

	"github.com/boxlite-ai/runner/pkg/api/dto"
)

func TestNestedVirtualizationRunnerCombinesKernelAndNesting(t *testing.T) {
	for _, test := range []struct {
		name       string
		privileged bool
	}{{"ordinary", false}, {"privileged", true}} {
		t.Run(test.name, func(t *testing.T) {
			kernel := filepath.Join(t.TempDir(), "kernel.bin")
			if err := os.WriteFile(kernel, []byte("raw-kernel-fixture"), 0600); err != nil {
				t.Fatal(err)
			}
			cfg := ClientConfig{HomeDir: t.TempDir(), KernelPath: kernel, ExperimentalFeatures: "nested-virtualization"}
			request := dto.CreateBoxDTO{
				Id: "combined", Image: "alpine:latest", CpuQuota: cpuQuota(2),
				SkipStart: boolPtr(true), OutboundEnabled: boolPtr(false),
				NestedVirtualization: true, Privileged: test.privileged,
			}
			// Native REST validation checks the actual advanced options before I/O.
			// Losing the kernel while adding nesting would report nesting instead.
			rest, err := sdk.NewRest(sdk.BoxliteRestOptions{URL: "http://127.0.0.1:1"})
			if err != nil {
				t.Fatal(err)
			}
			probe := &Client{runtime: rest, kernelPath: kernel, nestedVirtualizationAllowed: true}
			_, _, forwardedErr := probe.Create(t.Context(), request)
			rest.Close()
			var nativeErr *sdk.Error
			if !errors.As(forwardedErr, &nativeErr) || nativeErr.Code != sdk.ErrUnsupported || !strings.Contains(forwardedErr.Error(), "custom kernels") {
				t.Fatalf("combined options lost the custom kernel: %v", forwardedErr)
			}

			// Reopening and replaying retains saved kernel and privilege options.
			for attempt := 0; attempt < 2; attempt++ {
				client, err := NewClient(t.Context(), cfg)
				if err != nil {
					if os.Getenv("BOXLITE_REQUIRE_NESTED_RUNTIME_TESTS") == "1" {
						t.Fatalf("combined feature qualification requires a local runtime: %v", err)
					}
					skipOrFailRuntimeStart(t, err)
				}
				_, _, createErr := client.Create(t.Context(), request)
				closeErr := client.Close()
				if createErr != nil {
					t.Fatalf("combined create/replay %d: %v", attempt, createErr)
				}
				if closeErr != nil {
					t.Fatal(closeErr)
				}
			}
		})
	}
}

func TestNestedVirtualizationRunnerKernelPreservesFeatureValidation(t *testing.T) {
	kernel := filepath.Join(t.TempDir(), "kernel.bin")
	if err := os.WriteFile(kernel, []byte("raw-kernel-fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	client, err := NewClient(t.Context(), ClientConfig{
		HomeDir: t.TempDir(), KernelPath: kernel,
		ExperimentalFeatures: "nested-virtualization,unknown-startup-feature",
	})
	if client != nil {
		client.Close()
	}
	if err == nil || !strings.Contains(err.Error(), "unknown-startup-feature") {
		t.Fatalf("custom kernel must preserve startup feature validation: %v", err)
	}
}
