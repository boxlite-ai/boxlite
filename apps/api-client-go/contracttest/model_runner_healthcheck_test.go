package contracttest

import (
	"encoding/json"
	"reflect"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

func TestRunnerHealthcheckCarriesAdvertisedFeatures(t *testing.T) {
	healthcheck := apiclient.NewRunnerHealthcheck("v1.0.0")
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
	var healthcheck apiclient.RunnerHealthcheck
	if err := json.Unmarshal([]byte(`{"appVersion":"v1.0.0","features":["linux-capabilities-v2"]}`), &healthcheck); err != nil {
		t.Fatalf("unmarshal healthcheck: %v", err)
	}

	if _, exists := healthcheck.AdditionalProperties["features"]; exists {
		t.Fatal("known features field must not remain in AdditionalProperties")
	}
}
