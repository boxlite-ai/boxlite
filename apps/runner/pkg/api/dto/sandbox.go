// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package dto

// SecurityResourceLimitsDTO carries process resource limits from the hosted API to the runner.
// Field names use snake_case to match Rust SecurityOptions serde fields.
type SecurityResourceLimitsDTO struct {
	MaxOpenFiles *uint64 `json:"max_open_files,omitempty"`
	MaxFileSize  *uint64 `json:"max_file_size,omitempty"`
	MaxProcesses *uint64 `json:"max_processes,omitempty"`
	MaxMemory    *uint64 `json:"max_memory,omitempty"`
	MaxCpuTime   *uint64 `json:"max_cpu_time,omitempty"`
} //	@name	SecurityResourceLimitsDTO

// SecurityOptionsDTO carries security isolation settings from the hosted API to the runner.
// Field names use snake_case to match Rust SecurityOptions serde fields.
type SecurityOptionsDTO struct {
	Preset         *string                    `json:"preset,omitempty"`
	JailerEnabled  *bool                      `json:"jailer_enabled,omitempty"`
	SeccompEnabled *bool                      `json:"seccomp_enabled,omitempty"`
	UID            *uint32                    `json:"uid,omitempty"`
	GID            *uint32                    `json:"gid,omitempty"`
	NewPIDNS       *bool                      `json:"new_pid_ns,omitempty"`
	NewNetNS       *bool                      `json:"new_net_ns,omitempty"`
	ChrootBase     *string                    `json:"chroot_base,omitempty"`
	ChrootEnabled  *bool                      `json:"chroot_enabled,omitempty"`
	CloseFDs       *bool                      `json:"close_fds,omitempty"`
	SanitizeEnv    *bool                      `json:"sanitize_env,omitempty"`
	EnvAllowlist   *[]string                  `json:"env_allowlist,omitempty"`
	ResourceLimits *SecurityResourceLimitsDTO `json:"resource_limits,omitempty"`
	SandboxProfile *string                    `json:"sandbox_profile,omitempty"`
	NetworkEnabled *bool                      `json:"network_enabled,omitempty"`
} //	@name	SecurityOptionsDTO

type CreateSandboxDTO struct {
	Id               string            `json:"id" validate:"required"`
	FromVolumeId     string            `json:"fromVolumeId,omitempty"`
	UserId           string            `json:"userId" validate:"required"`
	Snapshot         string            `json:"snapshot" validate:"required"`
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

	// Nullable for backward compatibility
	OrganizationId *string `json:"organizationId,omitempty"`
	RegionId       *string `json:"regionId,omitempty"`

	// Security isolation options. When present, effectiveSecurityOptions computed by apps/api.
	Security *SecurityOptionsDTO `json:"security,omitempty"`
} //	@name	CreateSandboxDTO

type ResizeSandboxDTO struct {
	Cpu    int64 `json:"cpu,omitempty" validate:"omitempty,min=1"`
	Gpu    int64 `json:"gpu,omitempty" validate:"omitempty,min=0"`
	Memory int64 `json:"memory,omitempty" validate:"omitempty,min=1"`
	Disk   int64 `json:"disk,omitempty" validate:"omitempty,min=1"`
} //	@name	ResizeSandboxDTO

type UpdateNetworkSettingsDTO struct {
	NetworkBlockAll    *bool   `json:"networkBlockAll,omitempty"`
	NetworkAllowList   *string `json:"networkAllowList,omitempty"`
	NetworkLimitEgress *bool   `json:"networkLimitEgress,omitempty"`
} //	@name	UpdateNetworkSettingsDTO

type RecoverSandboxDTO struct {
	FromVolumeId      string            `json:"fromVolumeId,omitempty"`
	UserId            string            `json:"userId" validate:"required"`
	Snapshot          *string           `json:"snapshot,omitempty"`
	OsUser            string            `json:"osUser" validate:"required"`
	CpuQuota          int64             `json:"cpuQuota" validate:"min=1"`
	GpuQuota          int64             `json:"gpuQuota" validate:"min=0"`
	MemoryQuota       int64             `json:"memoryQuota" validate:"min=1"`
	StorageQuota      int64             `json:"storageQuota" validate:"min=1"`
	Env               map[string]string `json:"env,omitempty"`
	Volumes           []VolumeDTO       `json:"volumes,omitempty"`
	NetworkBlockAll   *bool             `json:"networkBlockAll,omitempty"`
	NetworkAllowList  *string           `json:"networkAllowList,omitempty"`
	ErrorReason       string            `json:"errorReason" validate:"required"`
	BackupErrorReason string            `json:"backupErrorReason,omitempty"`
} //	@name	RecoverSandboxDTO

type IsRecoverableDTO struct {
	ErrorReason string `json:"errorReason" validate:"required"`
} //	@name	IsRecoverableDTO

type IsRecoverableResponse struct {
	Recoverable bool `json:"recoverable"`
} //	@name	IsRecoverableResponse
type StartSandboxResponse struct {
	DaemonVersion string `json:"daemonVersion"`
} //	@name	StartSandboxResponse

type StopSandboxDTO struct {
	Force bool `json:"force,omitempty"`
} //	@name	StopSandboxDTO
