//go:build boxlite_dev

package boxlite

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
	"github.com/boxlite-ai/runner/pkg/common"
	"github.com/gin-gonic/gin"
)

func TestNestedVirtualizationRunnerCreateAndReplay(t *testing.T) {
	cfg := ClientConfig{HomeDir: t.TempDir()}
	plain, err := sdk.NewRuntime(sdk.WithHomeDir(cfg.HomeDir))
	if err != nil {
		if os.Getenv("BOXLITE_REQUIRE_NESTED_RUNTIME_TESTS") == "1" {
			t.Fatalf("nested runtime qualification requires a usable local runtime: %v", err)
		}
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
	request := dto.CreateBoxDTO{Id: "plain", Image: "alpine:latest", SkipStart: boolPtr(true), OutboundEnabled: boolPtr(false), NestedVirtualization: true}
	if _, _, err := client.Create(t.Context(), request); err == nil || !strings.Contains(err.Error(), "created without nested virtualization") {
		t.Fatalf("plain-box replay must reject the nested requirement: %v", err)
	}
	request.Id = "nested"
	for i := 0; i < 2; i++ {
		if _, _, err := client.Create(t.Context(), request); err != nil {
			t.Fatalf("nested create/replay %d: %v", i, err)
		}
	}
}

func TestNestedVirtualizationRunnerRejectsInvalidFeatures(t *testing.T) {
	for _, value := range []string{"unknown", "nested-virtualization,", ",nested-virtualization", "nested-virtualization\x00"} {
		client, err := NewClient(t.Context(), ClientConfig{HomeDir: t.TempDir(), ExperimentalFeatures: value})
		if client != nil {
			client.Close()
		}
		if err == nil {
			t.Errorf("accepted invalid experimental features %q", value)
		}
	}
}

func TestNestedVirtualizationDeniedBeforeSideEffects(t *testing.T) {
	// A zero client cannot mount volumes or reach the runtime. Authorization
	// must reject the request before either resource is accessed.
	client := &Client{}
	_, _, err := client.Create(t.Context(), dto.CreateBoxDTO{NestedVirtualization: true})
	if err == nil || !strings.Contains(err.Error(), "BOXLITE_EXPERIMENTAL") {
		t.Fatalf("unauthorized create must fail before side effects: %v", err)
	}
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = httptest.NewRequest(http.MethodPost, "/boxes", nil)
	response := common.HandlePossibleDockerError(ctx, err)
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("unauthorized nesting maps to HTTP %d, want 400", response.StatusCode)
	}
}

func TestNestedVirtualizationRunnerForwardsToNativeOptions(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/boxes/forwarding":
			http.NotFound(w, r)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/config":
			_, _ = w.Write([]byte(`{"capabilities":{"nested_virtualization_enabled":true}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/v1/boxes":
			var request struct {
				Advanced struct {
					NestedVirtualization bool `json:"nested_virtualization"`
				} `json:"advanced"`
			}
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil || !request.Advanced.NestedVirtualization {
				t.Errorf("Runner did not forward the native nested requirement: %v", err)
				http.Error(w, "missing requirement", http.StatusBadRequest)
				return
			}
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"box_id":"forwarding","name":"forwarding","status":"configured","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","pid":null,"image":"alpine:latest","cpus":1,"memory_mib":128,"advanced":{"nested_virtualization":true}}`))
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	rt, err := sdk.NewRest(sdk.BoxliteRestOptions{URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	// The REST backend observes the real native option without requiring a
	// hypervisor. Local-runtime authorization and persistence are tested above.
	client := &Client{runtime: rt, nestedVirtualizationAllowed: true, logger: slog.Default(), boxes: make(map[string]*sdk.Box)}
	_, _, err = client.Create(t.Context(), dto.CreateBoxDTO{
		Id: "forwarding", Image: "alpine:latest", SkipStart: boolPtr(true),
		OutboundEnabled: boolPtr(false), NestedVirtualization: true,
	})
	if err != nil {
		t.Fatalf("Runner must forward nesting through the native REST request: %v", err)
	}
	defer client.boxes["forwarding"].Close()
	if requests.Load() != 3 {
		t.Fatalf("want lookup, capability check and create; got %d requests", requests.Load())
	}
}
