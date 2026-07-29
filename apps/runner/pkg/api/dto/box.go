// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package dto

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
	// 以下字段描述主进程启动方式，由控制面持久化后透传给 Runner。
	// 覆盖镜像中定义的 CMD，指定主进程的默认命令或参数。
	Cmd []string `json:"cmd,omitempty"`
	// 设置主进程在 Box 内的工作目录。
	WorkingDir *string `json:"workingDir,omitempty"`
	// 是否请求为主进程分配伪终端，用于交互式命令。
	TTY *bool `json:"tty,omitempty"`
	// 是否让 Box 在创建它的父进程退出后继续运行。
	Detach           *bool             `json:"detach,omitempty"`
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
