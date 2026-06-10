// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package enums

type BoxState string

const (
	BoxStateCreating        BoxState = "creating"
	BoxStateRestoring       BoxState = "restoring"
	BoxStateDestroyed       BoxState = "destroyed"
	BoxStateDestroying      BoxState = "destroying"
	BoxStateStarted         BoxState = "started"
	BoxStateStopped         BoxState = "stopped"
	BoxStateStarting        BoxState = "starting"
	BoxStateStopping        BoxState = "stopping"
	BoxStateResizing        BoxState = "resizing"
	BoxStateError           BoxState = "error"
	BoxStateUnknown         BoxState = "unknown"
)

func (s BoxState) String() string {
	return string(s)
}
