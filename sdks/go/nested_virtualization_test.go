package boxlite

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
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

func TestNestedVirtualizationSetterReachesNativeRESTBoundary(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != "/v1/boxes" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"box_id":"rest-box","name":"boundary","status":"configured","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","pid":null,"image":"alpine:latest","cpus":1,"memory_mib":128}`)
	}))
	defer server.Close()
	rt, err := NewRest(BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	advanced, err := NewAdvancedBoxOptions()
	if err != nil {
		t.Fatal(err)
	}
	defer advanced.Close()

	for _, enabled := range []bool{true, false, true} {
		if err := advanced.SetNestedVirtualization(enabled); err != nil {
			t.Fatal(err)
		}
		before := requests.Load()
		box, err := rt.Create(t.Context(), "alpine:latest", WithName("boundary"), WithAdvancedOptions(advanced))
		if box != nil {
			box.Close()
		}
		if enabled {
			var runtimeErr *Error
			if !errors.As(err, &runtimeErr) || runtimeErr.Code != ErrUnsupported || !strings.Contains(err.Error(), "nested virtualization") {
				t.Fatalf("native REST validation must reject nesting: %v", err)
			}
			if requests.Load() != before {
				t.Fatal("nesting must be rejected before HTTP")
			}
		} else if err != nil || box == nil || requests.Load() != before+1 {
			t.Fatalf("disabling nesting must allow native REST creation: box=%v error=%v requests=%d", box, err, requests.Load()-before)
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

func TestNestedVirtualizationRejectsCombinedFeatureName(t *testing.T) {
	t.Run("invalid_tokens", func(t *testing.T) {
		for _, feature := range []string{"custom-kernel,nested-virtualization", "nested-virtualization\x00"} {
			rt, err := NewRuntime(WithHomeDir(t.TempDir()), WithExperimentalFeatures(feature))
			if rt != nil {
				rt.Close()
			}
			if err == nil || !strings.Contains(err.Error(), "single tokens") {
				t.Fatalf("invalid feature %q must fail token validation before host initialization: %v", feature, err)
			}
		}
	})
	t.Run("valid_tokens", func(t *testing.T) {
		rt, err := NewRuntime(WithHomeDir(t.TempDir()), WithExperimentalFeatures("custom-kernel", "nested-virtualization"))
		if err != nil {
			var runtimeErr *Error
			if errors.As(err, &runtimeErr) && runtimeErr.Code == ErrUnsupported && os.Getenv("BOXLITE_REQUIRE_NESTED_RUNTIME_TESTS") != "1" {
				t.Skipf("host virtualization unavailable: %v", err)
			}
			t.Fatalf("distinct valid feature names must remain supported: %v", err)
		}
		rt.Close()
	})
}
