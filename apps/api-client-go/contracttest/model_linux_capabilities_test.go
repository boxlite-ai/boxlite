package contracttest

import (
	"encoding/json"
	"strings"
	"testing"

	apiclient "github.com/boxlite-ai/boxlite/libs/api-client-go"
)

func TestCapabilityModelsRejectNullRequiredValues(t *testing.T) {
	tests := []struct {
		name              string
		payload           string
		target            func() any
		wantErrorProperty string
	}{
		{
			name:              "add",
			payload:           `{"add":null,"drop":[]}`,
			target:            func() any { return &apiclient.LinuxCapabilities{} },
			wantErrorProperty: "add",
		},
		{
			name:              "drop",
			payload:           `{"add":[],"drop":null}`,
			target:            func() any { return &apiclient.LinuxCapabilities{} },
			wantErrorProperty: "drop",
		},
		{
			name:              "capabilities",
			payload:           `{"capabilities":null}`,
			target:            func() any { return &apiclient.BoxAdvancedOptions{} },
			wantErrorProperty: "add",
		},
		{
			name: "advanced",
			payload: `{
				"id":"box-1",
				"organizationId":"org-1",
				"name":"box",
				"user":"boxlite",
				"env":{},
				"advanced":null,
				"labels":{},
				"public":false,
				"networkBlockAll":false,
				"target":"local",
				"cpu":1,
				"gpu":0,
				"memory":1,
				"disk":10,
				"toolboxProxyUrl":""
			}`,
			target:            func() any { return &apiclient.Box{} },
			wantErrorProperty: "capabilities",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := json.Unmarshal([]byte(test.payload), test.target())
			if err == nil {
				t.Fatalf("expected %s to reject null", test.name)
			}
			if !strings.Contains(err.Error(), "required property "+test.wantErrorProperty) {
				t.Fatalf("unexpected error for %s: %v", test.name, err)
			}
		})
	}
}
