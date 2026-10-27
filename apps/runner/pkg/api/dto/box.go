// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package dto

// CreateBoxDTO carries two unrelated "user" fields. OsUser is a Daytona-era
// provisioning label: it only ever became a DAYTONA_SANDBOX_USER env var for a
// computer-use daemon that never read it, and nothing acts on it today.
// RunAsUser is the OCI process.user override (docker `-u`), empty when the
// caller did not ask for one so the image's own USER directive stands.
type CreateBoxDTO struct {
	Id           string            `json:"id" validate:"required"`
	FromVolumeId string            `json:"fromVolumeId,omitempty"`
	Image        string            `json:"image" validate:"required"`
	OsUser       string            `json:"osUser" validate:"required"`
	CpuQuota     int64             `json:"cpuQuota" validate:"min=1"`
	GpuQuota     int64             `json:"gpuQuota" validate:"min=0"`
	MemoryQuota  int64             `json:"memoryQuota" validate:"min=1"`
	StorageQuota int64             `json:"storageQuota" validate:"min=1"`
	Env          map[string]string `json:"env,omitempty"`
	Registry     *RegistryDTO      `json:"registry,omitempty"`
	Entrypoint   []string          `json:"entrypoint,omitempty"`
	Cmd          []string          `json:"cmd,omitempty"`
	WorkingDir   string            `json:"workingDir,omitempty"`
	RunAsUser    string            `json:"runAsUser,omitempty"`
	Volumes      []VolumeDTO       `json:"volumes,omitempty"`
	Secrets      []SecretDTO       `json:"secrets,omitempty" validate:"dive"`
	// Outbound network policy. outboundEnabled is required: a request without
	// it is rejected rather than started with a guessed policy.
	OutboundEnabled  *bool             `json:"outboundEnabled" validate:"required"`
	OutboundAllowNet []string          `json:"outboundAllowNet,omitempty"`
	Metadata         map[string]string `json:"metadata,omitempty"`
	AuthToken        *string           `json:"authToken,omitempty"`
	OtelEndpoint     *string           `json:"otelEndpoint,omitempty"`
	SkipStart        *bool             `json:"skipStart,omitempty"`

	// Nullable for backward compatibility
	OrganizationId *string `json:"organizationId,omitempty"`
	RegionId       *string `json:"regionId,omitempty"`
} //	@name	CreateBoxDTO

// Same outbound policy shape as CreateBoxDTO; an omitted field is left unchanged.
type UpdateNetworkSettingsDTO struct {
	OutboundEnabled    *bool    `json:"outboundEnabled,omitempty"`
	OutboundAllowNet   []string `json:"outboundAllowNet,omitempty"`
	NetworkLimitEgress *bool    `json:"networkLimitEgress,omitempty"`
} //	@name	UpdateNetworkSettingsDTO

type RecoverBoxDTO struct {
	FromVolumeId string            `json:"fromVolumeId,omitempty"`
	OsUser       string            `json:"osUser" validate:"required"`
	CpuQuota     int64             `json:"cpuQuota" validate:"min=1"`
	GpuQuota     int64             `json:"gpuQuota" validate:"min=0"`
	MemoryQuota  int64             `json:"memoryQuota" validate:"min=1"`
	StorageQuota int64             `json:"storageQuota" validate:"min=1"`
	Env          map[string]string `json:"env,omitempty"`
	Volumes      []VolumeDTO       `json:"volumes,omitempty"`
	Secrets      []SecretDTO       `json:"secrets,omitempty" validate:"dive"`
	// Outbound network policy. outboundEnabled is required: a request without
	// it is rejected rather than started with a guessed policy.
	OutboundEnabled  *bool    `json:"outboundEnabled" validate:"required"`
	OutboundAllowNet []string `json:"outboundAllowNet,omitempty"`
	ErrorReason      string   `json:"errorReason" validate:"required"`
} //	@name	RecoverBoxDTO

type IsRecoverableDTO struct {
	ErrorReason string `json:"errorReason" validate:"required"`
} //	@name	IsRecoverableDTO

type IsRecoverableResponse struct {
	Recoverable bool `json:"recoverable"`
} //	@name	IsRecoverableResponse
type StartBoxResponse struct {
	DaemonVersion string `json:"daemonVersion"`
} //	@name	StartBoxResponse

type StopBoxDTO struct {
	Force bool `json:"force,omitempty"`
} //	@name	StopBoxDTO
