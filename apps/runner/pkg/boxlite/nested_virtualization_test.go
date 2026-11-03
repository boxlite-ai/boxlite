//go:build boxlite_dev

package boxlite

import (
	"strings"
	"testing"

	sdk "github.com/boxlite-ai/boxlite/sdks/go"
	"github.com/boxlite-ai/runner/pkg/api/dto"
)

func TestNestedVirtualizationRunnerCreateAndReplay(t *testing.T) {
	cfg := ClientConfig{HomeDir: t.TempDir()}
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
}
