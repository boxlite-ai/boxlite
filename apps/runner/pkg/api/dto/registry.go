// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package dto

type RegistryDTO struct {
	Url      string  `json:"url" validate:"required"`
	Project  *string `json:"project" validate:"optional,omitempty"`
	Username *string `json:"username" validate:"omitempty"`
	Password *string `json:"password" validate:"omitempty"`
} //	@name	RegistryDTO

func (r *RegistryDTO) HasAuth() bool {
	return r.Username != nil && r.Password != nil && *r.Username != "" && *r.Password != ""
}
