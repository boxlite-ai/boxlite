//go:build boxlite_dev

package boxlite

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
)

func TestNestedVirtualizationRunnerCreateAndReplay(t *testing.T) {
	for _, kernel := range []bool{false, true} {
		t.Run(map[bool]string{false: "default kernel", true: "custom kernel"}[kernel], func(t *testing.T) {
			cfg := ClientConfig{HomeDir: t.TempDir()}
			if kernel {
				cfg.KernelPath = filepath.Join(t.TempDir(), "kernel.bin")
				if err := os.WriteFile(cfg.KernelPath, []byte("raw-kernel-fixture"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			// Persist a box created without nesting before the operator enables it.
			plain, err := sdk.NewRuntime(sdk.WithHomeDir(cfg.HomeDir))
			if err != nil {
				skipOrFailRuntimeStart(t, err)
			}
			box, err := plain.Create(t.Context(), "alpine:latest", sdk.WithName("plain"), sdk.WithAutoRemove(false), sdk.WithDetach(true))
			if box != nil {
				box.Close()
			}
			plain.Close()
			if err != nil {
				t.Fatal(err)
			}
			cfg.ExperimentalFeatures = " nested-virtualization ,nested-virtualization "
			client, err := NewClient(t.Context(), cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			request := dto.CreateBoxDTO{Id: "plain", Image: "alpine:latest", SkipStart: boolPtr(true), OutboundEnabled: boolPtr(false)}
			request.NestedVirtualization = true
			if _, _, err := client.Create(t.Context(), request); err == nil || !strings.Contains(err.Error(), "created without nested virtualization") {
				t.Fatalf("plain-box replay must reject the nested requirement: %v", err)
			}
			for _, privileged := range []bool{false, true} {
				request.Id = map[bool]string{false: "nested", true: "nested-privileged"}[privileged]
				request.Privileged = privileged
				for i := 0; i < 2; i++ {
					if _, _, err := client.Create(t.Context(), request); err != nil {
						t.Fatalf("nested create/replay %d (privileged=%v): %v", i, privileged, err)
					}
				}
			}
		})
	}
}

func TestNestedVirtualizationRunnerRejectsInvalidFeatures(t *testing.T) {
	for _, value := range []string{"unknown", "nested-virtualization,", ",nested-virtualization", "nested-virtualization\x00"} {
		cfg := ClientConfig{HomeDir: t.TempDir()}
		cfg.ExperimentalFeatures = value
		client, err := NewClient(t.Context(), cfg)
		if client != nil {
			client.Close()
		}
		if err == nil {
			t.Errorf("accepted invalid experimental features %q", value)
		}
	}
}

func TestNestedVirtualizationRunnerDisabledByDefault(t *testing.T) {
	for _, value := range []string{"", "  "} {
		cfg := ClientConfig{HomeDir: t.TempDir()}
		cfg.ExperimentalFeatures = value
		client, err := NewClient(t.Context(), cfg)
		if err != nil {
			skipOrFailRuntimeStart(t, err)
		}
		request := dto.CreateBoxDTO{Id: "plain", Image: "alpine:latest", SkipStart: boolPtr(true), OutboundEnabled: boolPtr(false)}
		_, _, err = client.Create(t.Context(), request)
		client.Close()
		if err != nil {
			t.Fatal(err)
		}
		// Request nesting through the SDK: a default Runner must have persisted false.
		rt, err := sdk.NewRuntime(sdk.WithHomeDir(cfg.HomeDir), sdk.WithExperimentalFeatures("nested-virtualization"))
		if err != nil {
			t.Fatal(err)
		}
		advanced, err := sdk.NewAdvancedBoxOptions()
		if err != nil {
			t.Fatal(err)
		}
		if err := advanced.SetNestedVirtualization(true); err != nil {
			t.Fatal(err)
		}
		box, _, err := rt.GetOrCreate(t.Context(), request.Image, sdk.WithName(request.Id), sdk.WithAdvancedOptions(advanced))
		if box != nil {
			box.Close()
		}
		advanced.Close()
		rt.Close()
		if err == nil || !strings.Contains(err.Error(), "created without nested virtualization") {
			t.Fatalf("default Runner unexpectedly enabled nesting: %v", err)
		}
	}
}
