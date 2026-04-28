// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package enums

type SandboxState string

const (
	SandboxStateCreating        SandboxState = "creating"
	SandboxStateRestoring       SandboxState = "restoring"
	SandboxStateDestroyed       SandboxState = "destroyed"
	SandboxStateDestroying      SandboxState = "destroying"
	SandboxStateStarted         SandboxState = "started"
	SandboxStateStopped         SandboxState = "stopped"
	SandboxStateStarting        SandboxState = "starting"
	SandboxStateStopping        SandboxState = "stopping"
	SandboxStateResizing        SandboxState = "resizing"
	SandboxStateError           SandboxState = "error"
	SandboxStateUnknown         SandboxState = "unknown"
	SandboxStatePullingSnapshot SandboxState = "pulling_snapshot"
)

func (s SandboxState) String() string {
	return string(s)
}
