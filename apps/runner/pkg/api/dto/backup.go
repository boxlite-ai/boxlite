// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package dto

type CreateBackupDTO struct {
	Registry RegistryDTO `json:"registry" validate:"required"`
	Snapshot string      `json:"snapshot" validate:"required"`
} //	@name	CreateBackupDTO
