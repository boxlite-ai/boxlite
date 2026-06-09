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

type BuildArtifactRequestDTO struct {
	ArtifactRef            string        `json:"artifactRef,omitempty"` // Artifact ref or the build's hash
	SourceRegistries       []RegistryDTO `json:"sourceRegistries,omitempty"`
	Registry               *RegistryDTO  `json:"registry,omitempty"`
	Dockerfile             string        `json:"dockerfile" validate:"required"`
	OrganizationId         string        `json:"organizationId" validate:"required"`
	Context                []string      `json:"context"`
	PushToInternalRegistry bool          `json:"pushToInternalRegistry"`
} //	@name	BuildArtifactRequestDTO

type TagImageRequestDTO struct {
	SourceImage string `json:"sourceImage" validate:"required"`
	TargetImage string `json:"targetImage" validate:"required"`
} //	@name	TagImageRequestDTO
