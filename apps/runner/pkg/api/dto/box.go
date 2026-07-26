// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package dto

// GuestSshCaKeyDTO is one certificate authority the in-guest SSH server trusts.
//
// Public material only: an OpenSSH CA *public* key plus its non-secret
// signer/version identifier. No private key is ever sent to the runner.
type GuestSshCaKeyDTO struct {
	KeyId     string `json:"keyId" validate:"required"`
	PublicKey string `json:"publicKey" validate:"required"`
} //	@name	GuestSshCaKeyDTO

// GuestSshTrustDTO configures the in-guest SSH server's certificate trust.
//
// Every certificate the guest accepts must be signed by one of CaKeys and must
// name OrganizationId and BoxId, so access is pinned to a single box in a
// single organization. CaKeys holds the current CA, plus the next one while a
// rotation is in flight; at least one is required, because a listener with no
// trusted CA accepts nothing.
//
// Create-time only: the runner persists it with the box options and replays it
// on every start, so stop/start never picks up a rotated CA. Changing the
// trust set requires recreating or replacing the box.
type GuestSshTrustDTO struct {
	ListenAddr     string             `json:"listenAddr" validate:"required,hostname_port"`
	OrganizationId string             `json:"organizationId" validate:"required"`
	BoxId          string             `json:"boxId" validate:"required"`
	CaKeys         []GuestSshCaKeyDTO `json:"caKeys" validate:"required,min=1,dive"`
} //	@name	GuestSshTrustDTO

type CreateBoxDTO struct {
	Id               string            `json:"id" validate:"required"`
	FromVolumeId     string            `json:"fromVolumeId,omitempty"`
	Image            string            `json:"image" validate:"required"`
	OsUser           string            `json:"osUser" validate:"required"`
	CpuQuota         int64             `json:"cpuQuota" validate:"min=1"`
	GpuQuota         int64             `json:"gpuQuota" validate:"min=0"`
	MemoryQuota      int64             `json:"memoryQuota" validate:"min=1"`
	StorageQuota     int64             `json:"storageQuota" validate:"min=1"`
	Env              map[string]string `json:"env,omitempty"`
	Registry         *RegistryDTO      `json:"registry,omitempty"`
	Entrypoint       []string          `json:"entrypoint,omitempty"`
	Volumes          []VolumeDTO       `json:"volumes,omitempty"`
	NetworkBlockAll  *bool             `json:"networkBlockAll,omitempty"`
	NetworkAllowList *string           `json:"networkAllowList,omitempty"`
	Metadata         map[string]string `json:"metadata,omitempty"`
	AuthToken        *string           `json:"authToken,omitempty"`
	OtelEndpoint     *string           `json:"otelEndpoint,omitempty"`
	SkipStart        *bool             `json:"skipStart,omitempty"`
	GuestSshTrust    *GuestSshTrustDTO `json:"guestSshTrust,omitempty" validate:"omitempty"`

	// Nullable for backward compatibility
	OrganizationId *string `json:"organizationId,omitempty"`
	RegionId       *string `json:"regionId,omitempty"`
} //	@name	CreateBoxDTO

type UpdateNetworkSettingsDTO struct {
	NetworkBlockAll    *bool   `json:"networkBlockAll,omitempty"`
	NetworkAllowList   *string `json:"networkAllowList,omitempty"`
	NetworkLimitEgress *bool   `json:"networkLimitEgress,omitempty"`
} //	@name	UpdateNetworkSettingsDTO

type RecoverBoxDTO struct {
	FromVolumeId     string            `json:"fromVolumeId,omitempty"`
	OsUser           string            `json:"osUser" validate:"required"`
	CpuQuota         int64             `json:"cpuQuota" validate:"min=1"`
	GpuQuota         int64             `json:"gpuQuota" validate:"min=0"`
	MemoryQuota      int64             `json:"memoryQuota" validate:"min=1"`
	StorageQuota     int64             `json:"storageQuota" validate:"min=1"`
	Env              map[string]string `json:"env,omitempty"`
	Volumes          []VolumeDTO       `json:"volumes,omitempty"`
	NetworkBlockAll  *bool             `json:"networkBlockAll,omitempty"`
	NetworkAllowList *string           `json:"networkAllowList,omitempty"`
	ErrorReason      string            `json:"errorReason" validate:"required"`
	// Recovery rebuilds the VM, so the caller must resend the trust bundle it
	// wants the new generation to have — the destroyed box's options are gone.
	GuestSshTrust *GuestSshTrustDTO `json:"guestSshTrust,omitempty" validate:"omitempty"`
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
