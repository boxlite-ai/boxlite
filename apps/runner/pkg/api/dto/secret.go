// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package dto

type SecretDTO struct {
	Name        string   `json:"name" validate:"required"`
	Value       string   `json:"value" validate:"required"`
	Hosts       []string `json:"hosts,omitempty"`
	Placeholder string   `json:"placeholder,omitempty"`
}
