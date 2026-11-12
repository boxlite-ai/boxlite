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

// FilestoreRef dispatches one filestore volume mount. Instance is the volume
// row's logical instance name — it keys the mount root
// (/mnt/boxlite-filestore-<name>) and the mount record, and it is the only
// piece the public API request or the persisted Volume row ever carries.
// Server, Export and MountOptions are resolved by the API from its
// FILESTORE_INSTANCES configuration at dispatch time and travel only inside
// the internal dispatch DTO and the box's persisted volume metadata; the
// runner consumes them as given. An instance recreated under the same name
// needs a config update, not a change to historical boxes.
type FilestoreRef struct {
	Instance string `json:"instance"`
	// Server and Export name the NFS target the API resolved for Instance.
	// Dispatch omits neither: an empty one is a dispatch bug and fails the
	// mount loudly rather than mounting the wrong target.
	Server string `json:"server"`
	// Export is the NFS export path on Server (Filestore's default is /vol1).
	Export string `json:"export"`
	// MountOptions carries the operator's extra mount options, appended to the
	// pinned NFSv4.1+hard base. Optional; the API's config boundary rejects
	// the pinned options, and the runner appends whatever survives.
	MountOptions []string `json:"mountOptions,omitempty"`
}
