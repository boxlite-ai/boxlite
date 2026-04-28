/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Runner } from '../entities/runner.entity'

export class RunnerCreatedEvent {
  constructor(public readonly runner: Runner) {}
}
