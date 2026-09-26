// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package dto

type VolumeDTO struct {
	VolumeId  string  `json:"volumeId"`
	MountPath string  `json:"mountPath"`
	Subpath   *string `json:"subpath,omitempty"`
	// ReadOnly binds the volume (or its Subpath) into the box read-only.
	// Omitted on the wire means read-write, so an older API that never sends
	// it keeps today's behaviour.
	ReadOnly bool `json:"readOnly,omitempty"`
}
