// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package dto

import (
	"bytes"
	"encoding/json"
	"fmt"
)

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

	// Nullable for backward compatibility
	OrganizationId *string `json:"organizationId,omitempty"`
	RegionId       *string `json:"regionId,omitempty"`

	// Advanced is execution-only on this legacy wire DTO. Capability-bearing
	// requests use CreateBoxWithCapabilitiesDTO so old endpoints cannot silently
	// discard policy fields they do not understand.
	Advanced *AdvancedBoxOptionsDTO `json:"-" swaggerignore:"true"`
} //	@name	CreateBoxDTO

type CreateBoxWithCapabilitiesDTO struct {
	CreateBoxDTO
	Advanced *AdvancedBoxOptionsDTO `json:"advanced" validate:"required"`
} //	@name	CreateBoxWithCapabilitiesDTO

func (d CreateBoxWithCapabilitiesDTO) HasCapabilityPolicy() bool {
	return d.Advanced != nil && d.Advanced.HasCapabilityPolicy()
}

func (d CreateBoxWithCapabilitiesDTO) AsCreateBoxDTO() CreateBoxDTO {
	request := d.CreateBoxDTO
	request.Advanced = d.Advanced.Clone()
	return request
}

type AdvancedBoxOptionsDTO struct {
	Capabilities *ContainerCapabilitiesDTO `json:"capabilities" validate:"required"`
} //	@name	AdvancedBoxOptionsDTO

func (d *AdvancedBoxOptionsDTO) HasCapabilityPolicy() bool {
	return d != nil && d.Capabilities != nil && !d.Capabilities.IsEmpty()
}

func (d *AdvancedBoxOptionsDTO) Clone() *AdvancedBoxOptionsDTO {
	if d == nil {
		return nil
	}

	clone := &AdvancedBoxOptionsDTO{}
	if d.Capabilities != nil {
		clone.Capabilities = &ContainerCapabilitiesDTO{
			Add:  append([]string(nil), d.Capabilities.Add...),
			Drop: append([]string(nil), d.Capabilities.Drop...),
		}
	}
	return clone
}

type ContainerCapabilitiesDTO struct {
	Add  []string `json:"add,omitempty" validate:"omitempty,dive,required"`
	Drop []string `json:"drop,omitempty" validate:"omitempty,dive,required"`
} //	@name	ContainerCapabilitiesDTO

func (d *ContainerCapabilitiesDTO) UnmarshalJSON(data []byte) error {
	type containerCapabilitiesWire struct {
		Add  json.RawMessage `json:"add"`
		Drop json.RawMessage `json:"drop"`
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var wire containerCapabilitiesWire
	if err := decoder.Decode(&wire); err != nil {
		return err
	}

	add, err := decodeCapabilityList("add", wire.Add)
	if err != nil {
		return err
	}
	drop, err := decodeCapabilityList("drop", wire.Drop)
	if err != nil {
		return err
	}

	d.Add = add
	d.Drop = drop
	return nil
}

func decodeCapabilityList(field string, raw json.RawMessage) ([]string, error) {
	if raw == nil {
		return nil, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, fmt.Errorf("advanced.capabilities.%s must not be null", field)
	}

	var capabilities []string
	if err := json.Unmarshal(raw, &capabilities); err != nil {
		return nil, fmt.Errorf("decode advanced.capabilities.%s: %w", field, err)
	}
	return capabilities, nil
}

func (d *ContainerCapabilitiesDTO) IsEmpty() bool {
	return d == nil || (len(d.Add) == 0 && len(d.Drop) == 0)
}

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

	// Advanced is populated only after decoding the strict wire DTO.
	Advanced *AdvancedBoxOptionsDTO `json:"-" swaggerignore:"true"`
} //	@name	RecoverBoxDTO

type RecoverBoxWithCapabilitiesDTO struct {
	RecoverBoxDTO
	Advanced *AdvancedBoxOptionsDTO `json:"advanced" validate:"required"`
} //	@name	RecoverBoxWithCapabilitiesDTO

func (d RecoverBoxWithCapabilitiesDTO) HasCapabilityPolicy() bool {
	return d.Advanced != nil && d.Advanced.HasCapabilityPolicy()
}

func (d RecoverBoxWithCapabilitiesDTO) AsRecoverBoxDTO() RecoverBoxDTO {
	request := d.RecoverBoxDTO
	request.Advanced = d.Advanced.Clone()
	return request
}

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
