//go:build boxlite_dev

package boxlite

import (
	"os"
	"testing"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
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
	var plainID string
	if box != nil {
		plainID = box.ID()
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
	if reusedID, _, err := client.Create(t.Context(), request); err != nil || reusedID != plainID {
		t.Fatalf("plain-box replay must reuse %q, got %q: %v", plainID, reusedID, err)
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

func TestNestedVirtualizationUnavailableFallsBackOnCreate(t *testing.T) {
	client, err := NewClient(t.Context(), ClientConfig{HomeDir: t.TempDir()})
	if err != nil {
		skipOrFailRuntimeStart(t, err)
	}
	defer client.Close()
	if client.NestedVirtualizationEnabled() {
		t.Fatal("unauthorized Runner advertised nesting")
	}
	id, _, err := client.Create(t.Context(), dto.CreateBoxDTO{
		Id: "optional-nesting", Image: "alpine:latest", NestedVirtualization: true,
		SkipStart: boolPtr(true), OutboundEnabled: boolPtr(false),
	})
	if err != nil {
		t.Fatalf("ordinary fallback create: %v", err)
	}
	info, err := client.runtime.GetInfo(t.Context(), id)
	if err != nil || info.ID != id {
		t.Fatalf("ordinary box was not created: %+v %v", info, err)
	}
}
