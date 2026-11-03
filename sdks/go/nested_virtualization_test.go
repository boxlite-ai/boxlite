package boxlite

import (
	"errors"
	"strings"
	"testing"
)

func TestNestedVirtualizationRequiresExplicitRuntimeFeature(t *testing.T) {
	t.Setenv("BOXLITE_EXPERIMENTAL", "nested-virtualization")
	for _, allow := range []bool{false, true} {
		t.Run(map[bool]string{false: "env only", true: "explicit feature"}[allow], func(t *testing.T) {
			opts := []RuntimeOption{WithHomeDir(t.TempDir())}
			if allow {
				opts = append(opts, WithExperimentalFeatures("nested-virtualization"))
			}
			rt, err := NewRuntime(opts...)
			if err != nil {
				var runtimeErr *Error
				if errors.As(err, &runtimeErr) && runtimeErr.Code == ErrUnsupported {
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
			for _, enabled := range []bool{true, false} {
				if err := advanced.SetNestedVirtualization(enabled); err != nil {
					t.Fatal(err)
				}
				box, err := rt.Create(t.Context(), "alpine:latest", WithAdvancedOptions(advanced))
				if box != nil {
					box.Close()
				}
				if enabled && !allow {
					if err == nil || !strings.Contains(err.Error(), "nested virtualization support is an RC feature and is disabled") {
						t.Fatalf("missing explicit authorization must reject nesting: %v", err)
					}
				} else if err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestNestedVirtualizationSetterRejectsClosedHandles(t *testing.T) {
	advanced, err := NewAdvancedBoxOptions()
	if err != nil {
		t.Fatal(err)
	}
	advanced.Close()
	for _, handle := range []*AdvancedBoxOptions{nil, advanced} {
		if err := handle.SetNestedVirtualization(true); err == nil {
			t.Fatal("accepted a nil or closed advanced-options handle")
		}
	}
}

func TestNestedVirtualizationRuntimeRejectsInvalidFeatures(t *testing.T) {
	for _, feature := range []string{"unknown", "nested-virtualization,", "nested-virtualization\x00"} {
		rt, err := NewRuntime(WithHomeDir(t.TempDir()), WithExperimentalFeatures(feature))
		if rt != nil {
			rt.Close()
		}
		if err == nil || !strings.Contains(err.Error(), "feature") {
			t.Fatalf("invalid feature %q must be rejected before host initialization: %v", feature, err)
		}
	}
}

func TestNestedVirtualizationFeatureOptionCopiesAndReplaces(t *testing.T) {
	features := []string{"nested-virtualization"}
	option := WithExperimentalFeatures(features...)
	cfg := &runtimeConfig{}
	option(cfg)
	features[0] = "unknown"
	if len(cfg.experimentalFeatures) != 1 || cfg.experimentalFeatures[0] != "nested-virtualization" {
		t.Fatal("experimental features must be copied from the caller")
	}
	WithExperimentalFeatures()(cfg)
	if len(cfg.experimentalFeatures) != 0 {
		t.Fatal("an empty option must clear previously selected features")
	}
}
