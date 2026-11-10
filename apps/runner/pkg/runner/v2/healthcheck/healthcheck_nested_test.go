package healthcheck

import (
	"encoding/json"
	"testing"
)

func TestNestedVirtualizationHealthcheckFormatsAuthorization(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		// Formatting uses its captured input without creating a runtime or reading ENV.
		t.Setenv("BOXLITE_EXPERIMENTAL", "unknown")
		service := &Service{}
		report := service.newHealthcheck(enabled)
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
