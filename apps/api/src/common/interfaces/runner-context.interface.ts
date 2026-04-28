/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BaseAuthContext } from './auth-context.interface'
import { Runner } from '../../sandbox/entities/runner.entity'

export interface RunnerContext extends BaseAuthContext {
  role: 'runner'
  runnerId: string
  runner: Runner
}

export function isRunnerContext(user: BaseAuthContext): user is RunnerContext {
  return 'role' in user && user.role === 'runner'
}
