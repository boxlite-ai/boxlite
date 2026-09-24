/*
 * Copyright BoxLite AI (originally Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

package models

import "github.com/boxlite-ai/runner/pkg/models/enums"

type BoxInfo struct {
	BoxState enums.BoxState
	// ExitCode is how the box's main command ended, set once the runtime
	// recorded it and nil otherwise. Stopping a box signals that command, so
	// this also carries what the stop produced. A pointer rather than an int
	// because 0 is the exit code of every command that succeeded, so it cannot
	// double as "no exit code recorded".
	ExitCode *int
}
