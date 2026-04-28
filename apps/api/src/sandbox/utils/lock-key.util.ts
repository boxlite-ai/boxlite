/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export function getStateChangeLockKey(id: string): string {
  return `sandbox:${id}:state-change`
}
