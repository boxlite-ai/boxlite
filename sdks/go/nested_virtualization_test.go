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
