// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package port

type PortList struct {
	Ports []uint `json:"ports"`
} // @name PortList

type IsPortInUseResponse struct {
	IsInUse bool `json:"isInUse"`
} // @name IsPortInUseResponse
