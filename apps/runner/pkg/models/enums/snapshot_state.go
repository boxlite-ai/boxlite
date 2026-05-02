// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package enums

type BackupState string

const (
	BackupStateNone       BackupState = "NONE"
	BackupStatePending    BackupState = "PENDING"
	BackupStateInProgress BackupState = "IN_PROGRESS"
	BackupStateCompleted  BackupState = "COMPLETED"
	BackupStateFailed     BackupState = "FAILED"
)

func (s BackupState) String() string {
	return string(s)
}
