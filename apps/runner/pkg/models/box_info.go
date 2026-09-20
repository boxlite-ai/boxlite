/*
 * Copyright BoxLite AI (originally Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

package models

import "github.com/boxlite-ai/runner/pkg/models/enums"

type BoxInfo struct {
	BoxState enums.BoxState
	// ExitCode is the main command's exit code, set when the box stopped
	// because that command exited, and nil otherwise. A pointer rather than an
	// int because 0 is the exit code of every command that succeeded, so it
	// cannot double as "no exit code recorded".
	ExitCode *int
}
