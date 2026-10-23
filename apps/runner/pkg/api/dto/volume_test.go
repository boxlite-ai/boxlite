// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

package dto

import (
	"encoding/json"
	"strings"
	"testing"
)

// A volume field this runner does not know may change how the volume is
// bound, as readOnly once did for runners built before it. The create body
// is refused rather than mounted without that field.
func TestCreateBoxRefusesAnUnknownVolumeField(t *testing.T) {
	body := `{"id":"box-1","volumes":[{"volumeId":"vol-1","mountPath":"/data","accessMode":"ro"}]}`

	var createBox CreateBoxDTO
	err := json.Unmarshal([]byte(body), &createBox)
	if err == nil || !strings.Contains(err.Error(), `"accessMode"`) {
		t.Fatalf("want an unknown field error naming accessMode, got %v", err)
	}
}

// Every field the API sends still decodes, including a null readOnly, which
// some JSON clients write for an unset optional.
func TestCreateBoxDecodesEveryKnownVolumeField(t *testing.T) {
	body := `{"id":"box-1","volumes":[` +
		`{"volumeId":"vol-1","mountPath":"/data","subpath":"sets/a","readOnly":true},` +
		`{"volumeId":"vol-2","mountPath":"/cache","readOnly":null}]}`

	var createBox CreateBoxDTO
	if err := json.Unmarshal([]byte(body), &createBox); err != nil {
		t.Fatalf("decode: %v", err)
	}

	first := createBox.Volumes[0]
	if first.VolumeId != "vol-1" || first.MountPath != "/data" || first.Subpath == nil ||
		*first.Subpath != "sets/a" || !first.ReadOnly {
		t.Errorf("first volume: got %+v", first)
	}
	if createBox.Volumes[1].ReadOnly {
		t.Error("a null readOnly must decode as read-write")
	}
}
