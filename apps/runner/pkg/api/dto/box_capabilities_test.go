// Copyright 2025 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package dto

import (
	"encoding/json"
	"reflect"
	"testing"
)

// The control plane and the runner agree on this wire shape; a rename or a
// dropped tag on either side would silently discard the privilege policy.
func TestBoxDTOsRoundTripCapabilityPolicy(t *testing.T) {
	payload := `{"advanced":{"capabilities":{"add":["SYS_ADMIN"],"drop":["NET_RAW"]}}}`

	t.Run("create", func(t *testing.T) {
		var request CreateBoxDTO
		if err := json.Unmarshal([]byte(payload), &request); err != nil {
			t.Fatalf("decode create payload: %v", err)
		}
		assertCapabilityPolicy(t, request.Advanced)
	})

	t.Run("recover", func(t *testing.T) {
		var request RecoverBoxDTO
		if err := json.Unmarshal([]byte(payload), &request); err != nil {
			t.Fatalf("decode recover payload: %v", err)
		}
		assertCapabilityPolicy(t, request.Advanced)
	})
}

func TestBoxDTOsOmitAnUnsetCapabilityPolicy(t *testing.T) {
	encoded, err := json.Marshal(CreateBoxDTO{})
	if err != nil {
		t.Fatalf("marshal create DTO: %v", err)
	}

	var wire map[string]any
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatalf("decode round-tripped payload: %v", err)
	}
	if _, ok := wire["advanced"]; ok {
		t.Fatalf("create DTO serialized an unset advanced policy: %s", encoded)
	}
}

func assertCapabilityPolicy(t *testing.T, advanced *AdvancedBoxOptionsDTO) {
	t.Helper()
	if advanced == nil || advanced.Capabilities == nil {
		t.Fatal("advanced.capabilities was dropped during decoding")
	}
	if !reflect.DeepEqual(advanced.Capabilities.Add, []string{"SYS_ADMIN"}) {
		t.Fatalf("unexpected advanced.capabilities.add: %v", advanced.Capabilities.Add)
	}
	if !reflect.DeepEqual(advanced.Capabilities.Drop, []string{"NET_RAW"}) {
		t.Fatalf("unexpected advanced.capabilities.drop: %v", advanced.Capabilities.Drop)
	}
}
