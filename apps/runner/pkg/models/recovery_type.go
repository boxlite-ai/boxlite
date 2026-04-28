// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package models

// RecoveryType represents the type of recovery operation
type RecoveryType string

const (
	RecoveryTypeStorageExpansion RecoveryType = "storage-expansion"
	UnknownRecoveryType          RecoveryType = ""
)
