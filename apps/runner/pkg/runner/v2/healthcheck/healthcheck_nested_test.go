package healthcheck

import (
	"encoding/json"
	"testing"

	blclient "github.com/boxlite-ai/runner/pkg/boxlite"
)

func healthcheckRuntime(t *testing.T, enabled bool) *blclient.Client {
	t.Helper()
	cfg := blclient.ClientConfig{HomeDir: t.TempDir()}
	if enabled {
		cfg.ExperimentalFeatures = "nested-virtualization"
	}
	client, err := blclient.NewClient(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := client.Close(); err != nil {
			t.Error(err)
		}
	})
	return client
}

func TestNestedVirtualizationHealthcheckUsesRuntimeSnapshot(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		client := healthcheckRuntime(t, enabled)
		// A later ENV change cannot grant or revoke the validated runtime policy.
		t.Setenv("BOXLITE_EXPERIMENTAL", "unknown")
		service := &Service{boxlite: client}
		report := service.newHealthcheck()
		body, err := json.Marshal(report)
		if err != nil {
			t.Fatal(err)
		}
		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatal(err)
		}
		for _, field := range []string{"nestedVirtualizationEnabled", "nestedVirtualizationStartEnabled"} {
			if payload[field] != enabled {
				t.Fatalf("%s = %v, want captured %t", field, payload[field], enabled)
			}
		}
	}
}
