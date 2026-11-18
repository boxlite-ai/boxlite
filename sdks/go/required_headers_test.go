package boxlite

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRequiredHeadersBeforeCConversion(t *testing.T) {
	for _, input := range []string{"", `,"Headers":null`, `,"Headers":{}`} {
		t.Run(input, func(t *testing.T) {
			var secret Secret
			if err := json.Unmarshal([]byte(`{"Name":"x","Value":"token","Hosts":["api.test.com"]`+input+`}`), &secret); err != nil {
				t.Fatal(err)
			}
			cfg := &boxConfig{secrets: []Secret{secret}}
			err := buildAndFreeCOptions("alpine", cfg)
			if !IsInvalidArgument(err) || !strings.Contains(err.Error(), `secret "x" has no headers; recreate the box with headers`) {
				t.Fatalf("expected actionable missing headers error, got %v", err)
			}
		})
	}
}
