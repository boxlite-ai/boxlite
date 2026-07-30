/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Runner } from '../entities/runner.entity'
import { RunnerState } from '../enums/runner-state.enum'
import { RunnerDto } from './runner.dto'

describe('RunnerDto scheduling state', () => {
  it('exposes whether the runner is draining', () => {
    const runner = new Runner({
      region: 'us',
      name: 'default',
      apiKey: 'runner-key',
      apiVersion: '2',
    })
    runner.id = '135b91a6-69ad-4fda-ba46-0f8a510f357e'
    runner.state = RunnerState.READY
    runner.unschedulable = false
    runner.draining = true
    runner.createdAt = new Date('2026-07-30T00:00:00.000Z')
    runner.updatedAt = new Date('2026-07-30T00:00:00.000Z')

    const dto = RunnerDto.fromRunner(runner)

    expect(dto).toHaveProperty('draining', true)
  })
})
