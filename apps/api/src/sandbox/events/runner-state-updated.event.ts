/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Runner } from '../entities/runner.entity'
import { RunnerState } from '../enums/runner-state.enum'

export class RunnerStateUpdatedEvent {
  constructor(
    public readonly runner: Runner,
    public readonly oldState: RunnerState,
    public readonly newState: RunnerState,
  ) {}
}
