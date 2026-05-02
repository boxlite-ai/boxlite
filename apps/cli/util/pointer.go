// Copyright 2025 BoxLite AI (originally Daytona Platforms Inc.
// Modified by BoxLite AI, 2025-2026
// SPDX-License-Identifier: AGPL-3.0

package util

// Use generics to create a pointer to a value
func Pointer[T any](d T) *T {
	return &d
}
