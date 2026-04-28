/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Sandbox } from '../entities/sandbox.entity'
import { SandboxDesiredState } from '../enums/sandbox-desired-state.enum'

export class SandboxDesiredStateUpdatedEvent {
  constructor(
    public readonly sandbox: Sandbox,
    public readonly oldDesiredState: SandboxDesiredState,
    public readonly newDesiredState: SandboxDesiredState,
  ) {}
}
