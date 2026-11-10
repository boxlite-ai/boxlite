// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package dto

type VolumeDTO struct {
	VolumeId  string  `json:"volumeId"`
	MountPath string  `json:"mountPath"`
	Subpath   *string `json:"subpath,omitempty"`
	// Filestore, when set, switches this volume to a GCP Filestore NFS mount
	// and VolumeId is left empty — the two reference forms are mutually
	// exclusive per volume, and the API enforces that before dispatch.
	Filestore *FilestoreRef `json:"filestore,omitempty"`
}

// FilestoreRef names the Filestore instance to mount, by the logical name it
// carries in the runner's FILESTORE_INSTANCES registry — never an address.
// The address is resolved from the registry at mount time, so an instance
// that is recreated under the same name needs no change to historical boxes.
type FilestoreRef struct {
	Instance string `json:"instance"`
}
