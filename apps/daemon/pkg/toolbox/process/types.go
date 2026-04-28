// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package process

type ExecuteRequest struct {
	Command string `json:"command" validate:"required"`
	// Timeout in seconds, defaults to 10 seconds
	Timeout *uint32 `json:"timeout,omitempty" validate:"optional"`
	// Current working directory
	Cwd *string `json:"cwd,omitempty" validate:"optional"`
} // @name ExecuteRequest

// TODO: Set ExitCode as required once all sandboxes migrated to the new daemon
type ExecuteResponse struct {
	ExitCode int    `json:"exitCode"`
	Result   string `json:"result" validate:"required"`
} // @name ExecuteResponse
