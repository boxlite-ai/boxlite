/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BaseAuthContext } from './auth-context.interface'
import { Runner } from '../../box/entities/runner.entity'

export interface RunnerContext extends BaseAuthContext {
  role: 'runner'
  runnerId: string
  runner: Runner
}

export function isRunnerContext(user: BaseAuthContext | null | undefined): user is RunnerContext {
  return Boolean(user) && user.role === 'runner'
}
