// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package dto

import (
	"bytes"
	"encoding/json"
)

type VolumeDTO struct {
	VolumeId  string  `json:"volumeId"`
	MountPath string  `json:"mountPath"`
	Subpath   *string `json:"subpath,omitempty"`
	// ReadOnly binds the volume (or its Subpath) into the box read-only.
	// Omitted on the wire means read-write, so an older API that never sends
	// it keeps today's behaviour.
	ReadOnly bool `json:"readOnly,omitempty"`
}

// UnmarshalJSON refuses a field this runner does not know. Such a field may
// change how the volume is bound, as readOnly did for runners built before
// it, so dropping it could mount a volume with more access than asked for.
func (v *VolumeDTO) UnmarshalJSON(data []byte) error {
	type plain VolumeDTO
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode((*plain)(v))
}
