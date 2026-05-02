// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package models

import (
	"github.com/boxlite-ai/runner/pkg/models/enums"
)

type BackupInfo struct {
	State    enums.BackupState
	Snapshot string
	Error    error
}
