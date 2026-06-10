// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package dto

type PullArtifactRequestDTO struct {
	ArtifactRef         string       `json:"artifactRef" validate:"required"`
	Registry            *RegistryDTO `json:"registry,omitempty"`
	DestinationRegistry *RegistryDTO `json:"destinationRegistry,omitempty"`
	DestinationRef      *string      `json:"destinationRef,omitempty"`
	NewTag              *string      `json:"newTag,omitempty"`
} //	@name	PullArtifactRequestDTO

type TagImageRequestDTO struct {
	SourceImage string `json:"sourceImage" validate:"required"`
	TargetImage string `json:"targetImage" validate:"required"`
} //	@name	TagImageRequestDTO
