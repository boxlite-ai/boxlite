/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export class RunnerNotReadyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunnerNotReadyError'
  }
}
