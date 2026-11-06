//go:build boxlite_dev

package boxlite

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
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
			expected := features != ""
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

func TestNestedAllowlistRecoveryPreservesSavedDecision(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		for _, privileged := range []bool{false, true} {
			got := recoverCreateDto("box", dto.RecoverBoxDTO{NestedVirtualization: enabled, Privileged: privileged})
			if got.NestedVirtualization != enabled || got.Privileged != privileged {
				t.Fatalf("recovery changed saved nesting=%v privilege=%v: %+v", enabled, privileged, got)
			}
		}
	}
}

func TestNestedAllowlistRecoveryDeniesBeforeDelete(t *testing.T) {
	var deletes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			deletes.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{}`)
	}))
	defer server.Close()
	runtime, err := sdk.NewRest(sdk.BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	client := &Client{runtime: runtime, logger: slog.New(slog.NewTextHandler(io.Discard, nil)), homeDir: t.TempDir()}
	disabled := false
	err = client.RecoverBox(t.Context(), "saved-nested", dto.RecoverBoxDTO{NestedVirtualization: true, OutboundEnabled: &disabled})
	if err == nil {
		t.Fatal("unauthorized recovery accepted")
	}
	if got := deletes.Load(); got != 0 {
		t.Fatalf("DELETE count=%d, expected 0", got)
	}
}
