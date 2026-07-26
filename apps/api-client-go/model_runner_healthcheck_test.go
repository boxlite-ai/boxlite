package apiclient

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestRunnerHealthcheckCarriesAdvertisedFeatures(t *testing.T) {
	healthcheck := NewRunnerHealthcheck("v1.0.0")
	healthcheck.SetFeatures([]string{"linux-capabilities-v2"})

	payload, err := json.Marshal(healthcheck)
	if err != nil {
		t.Fatalf("marshal healthcheck: %v", err)
	}

	var wire map[string]any
	if err := json.Unmarshal(payload, &wire); err != nil {
		t.Fatalf("decode healthcheck: %v", err)
	}
	if !reflect.DeepEqual(wire["features"], []any{"linux-capabilities-v2"}) {
		t.Fatalf("features lost from healthcheck: %s", payload)
	}
}

func TestRunnerHealthcheckDoesNotTreatFeaturesAsAdditional(t *testing.T) {
	var healthcheck RunnerHealthcheck
	if err := json.Unmarshal([]byte(`{"appVersion":"v1.0.0","features":["linux-capabilities-v2"]}`), &healthcheck); err != nil {
		t.Fatalf("unmarshal healthcheck: %v", err)
	}

	if _, exists := healthcheck.AdditionalProperties["features"]; exists {
		t.Fatal("known features field must not remain in AdditionalProperties")
	}
}

func TestBoxDoesNotTreatCapabilitiesAsAdditional(t *testing.T) {
	box := NewBox(
		"box-1",
		"org-1",
		"cap-box",
		"boxlite",
		map[string]string{},
		*NewBoxAdvancedOptions(*NewLinuxCapabilities([]string{"SYS_ADMIN"}, []string{"NET_RAW"})),
		map[string]string{},
		true,
		false,
		"local",
		1,
		0,
		1,
		10,
		"https://example.test/toolbox",
	)
	payload, err := json.Marshal(box)
	if err != nil {
		t.Fatalf("marshal box: %v", err)
	}

	var decoded Box
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("unmarshal box: %v", err)
	}
	if _, exists := decoded.AdditionalProperties["advanced"]; exists {
		t.Fatal("known advanced field must not remain in AdditionalProperties")
	}
	if !reflect.DeepEqual(decoded.Advanced.Capabilities.Add, []string{"SYS_ADMIN"}) {
		t.Fatalf("advanced capabilities lost during round trip: %s", payload)
	}
}
