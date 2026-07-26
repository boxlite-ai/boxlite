// Copyright 2025 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package dto

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestLegacyCreateAndRecoverBoxDTOsDoNotSerializeCapabilities(t *testing.T) {
	tests := []struct {
		name    string
		request any
	}{
		{
			name: "create",
			request: CreateBoxDTO{
				Advanced: capabilityTestAdvancedOptions(),
			},
		},
		{
			name: "recover",
			request: RecoverBoxDTO{
				Advanced: capabilityTestAdvancedOptions(),
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			encoded, err := json.Marshal(test.request)
			if err != nil {
				t.Fatalf("marshal legacy DTO: %v", err)
			}

			var wire map[string]any
			if err := json.Unmarshal(encoded, &wire); err != nil {
				t.Fatalf("decode round-tripped payload: %v", err)
			}
			if _, ok := wire["advanced"]; ok {
				t.Fatalf("legacy %s DTO serialized advanced options: %s", test.name, encoded)
			}
		})
	}
}

func TestCapabilityCreateAndRecoverBoxDTOsPreserveCapabilities(t *testing.T) {
	tests := []struct {
		name   string
		decode func([]byte) ([]byte, error)
	}{
		{
			name: "create",
			decode: func(payload []byte) ([]byte, error) {
				var request CreateBoxWithCapabilitiesDTO
				if err := json.Unmarshal(payload, &request); err != nil {
					return nil, err
				}
				return json.Marshal(request)
			},
		},
		{
			name: "recover",
			decode: func(payload []byte) ([]byte, error) {
				var request RecoverBoxWithCapabilitiesDTO
				if err := json.Unmarshal(payload, &request); err != nil {
					return nil, err
				}
				return json.Marshal(request)
			},
		},
	}

	payload := []byte(`{"advanced":{"capabilities":{"add":["SYS_ADMIN"],"drop":["NET_RAW"]}}}`)
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			encoded, err := test.decode(payload)
			if err != nil {
				t.Fatalf("round trip capability payload: %v", err)
			}

			var wire map[string]any
			if err := json.Unmarshal(encoded, &wire); err != nil {
				t.Fatalf("decode round-tripped payload: %v", err)
			}
			advanced, ok := wire["advanced"].(map[string]any)
			if !ok {
				t.Fatalf("advanced options lost across %s DTO: %s", test.name, encoded)
			}
			capabilities, ok := advanced["capabilities"].(map[string]any)
			if !ok {
				t.Fatalf("capabilities lost across %s DTO: %s", test.name, encoded)
			}
			if !reflect.DeepEqual(capabilities["add"], []any{"SYS_ADMIN"}) {
				t.Fatalf("capabilities.add lost across %s DTO: %s", test.name, encoded)
			}
			if !reflect.DeepEqual(capabilities["drop"], []any{"NET_RAW"}) {
				t.Fatalf("capabilities.drop lost across %s DTO: %s", test.name, encoded)
			}
		})
	}
}

func capabilityTestAdvancedOptions() *AdvancedBoxOptionsDTO {
	return &AdvancedBoxOptionsDTO{
		Capabilities: &ContainerCapabilitiesDTO{
			Add:  []string{"SYS_ADMIN"},
			Drop: []string{"NET_RAW"},
		},
	}
}
