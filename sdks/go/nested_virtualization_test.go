package boxlite

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestNestedVirtualizationLocalEnvironment(t *testing.T) {
	t.Setenv("BOXLITE_EXPERIMENTAL", "nested-virtualization")
	rt, err := NewRuntime(WithHomeDir(t.TempDir()))
	if err != nil {
		var runtimeErr *Error
		if errors.As(err, &runtimeErr) && runtimeErr.Code == ErrUnsupported && os.Getenv("BOXLITE_REQUIRE_NESTED_RUNTIME_TESTS") != "1" {
			t.Skipf("host virtualization unavailable: %v", err)
		}
		t.Fatal(err)
	}
	defer rt.Close()
	box, err := rt.Create(t.Context(), "alpine:latest")
	if err != nil {
		t.Fatal(err)
	}
	box.Close()
}

func TestNestedVirtualizationInvalidEnvironmentFailsBeforeSetup(t *testing.T) {
	t.Setenv("BOXLITE_EXPERIMENTAL", "unknown")
	rt, err := NewRuntime(WithHomeDir(t.TempDir()))
	if rt != nil {
		rt.Close()
	}
	if err == nil || !strings.Contains(err.Error(), "unknown feature") {
		t.Fatalf("invalid local policy accepted: %v", err)
	}
}

func TestNestedVirtualizationRESTIgnoresLocalEnvironment(t *testing.T) {
	var bodies []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/boxes" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		bodies = append(bodies, body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"box_id":"rest-box","status":"configured","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","pid":null,"image":"alpine:latest","cpus":1,"memory_mib":128}`)
	}))
	defer server.Close()
	for _, value := range []string{"", "nested-virtualization", "unknown"} {
		t.Setenv("BOXLITE_EXPERIMENTAL", value)
		rt, err := NewRest(BoxliteRestOptions{URL: server.URL})
		if err != nil {
			t.Fatal(err)
		}
		box, err := rt.Create(t.Context(), "alpine:latest")
		if err != nil {
			rt.Close()
			t.Fatal(err)
		}
		box.Close()
		rt.Close()
	}
	if len(bodies) != 3 {
		t.Fatalf("got %d create requests", len(bodies))
	}
	for _, body := range bodies {
		if advanced, ok := body["advanced"].(map[string]any); ok {
			if _, exists := advanced["nested_virtualization"]; exists {
				t.Fatalf("local policy leaked to REST: %v", body)
			}
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
		for _, test := range []struct{ feature, message string }{
			{"custom-kernel,nested-virtualization", "experimental feature names cannot contain commas"},
			{"nested-virtualization\x00", "experimental feature names cannot contain NUL"},
		} {
			rt, err := NewRuntime(WithHomeDir(t.TempDir()), WithExperimentalFeatures(test.feature))
			if rt != nil {
				rt.Close()
			}
			if err == nil || err.Error() != "boxlite: "+test.message {
				t.Fatalf("invalid feature %q must fail token validation before host initialization: %v", test.feature, err)
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
