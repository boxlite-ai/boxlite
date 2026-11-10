/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { runnerDiskConfig } from './configuration'

describe('runnerDiskConfig', () => {
  it('defaults to no overcommit, no expand limit and a 10% free-space floor', () => {
    const config = runnerDiskConfig({})
    expect(config).toMatchObject({ overcommitRatio: 1, expandLimitGiB: undefined, minFreePercentage: 10 })
    // The expansion block defaults to fully dormant: enabled=false, no cap.
    // Off must mean today's behavior exactly — sampling, marks and GCP calls
    // all stay down while enabled is false.
    expect(config.expansion).toEqual({
      enabled: false,
      capGiB: undefined,
      triggerPercentage: 20,
      headroomFloorGiB: 20,
      stepPercentage: 25,
      safetyFactor: 2.0,
      growthWindowHours: 4,
      maxExpansionsPerWindow: 2,
      sampleIntervalMinutes: 10,
      sampleRetentionHours: 48,
      confirmTimeoutMinutes: 10,
      liftPercentage: 75,
    })
  })

  it('reads valid overrides', () => {
    expect(
      runnerDiskConfig({
        RUNNER_DISK_OVERCOMMIT_RATIO: '1.5',
        RUNNER_DISK_EXPAND_LIMIT_GIB: '4096',
        RUNNER_DISK_MIN_FREE_PERCENTAGE: '0',
        RUNNER_DISK_EXPANSION_ENABLED: 'true',
        RUNNER_DISK_EXPANSION_CAP_GIB: '512',
        RUNNER_DISK_EXPANSION_LIFT_PERCENT: '60',
      }),
    ).toMatchObject({
      overcommitRatio: 1.5,
      expandLimitGiB: 4096,
      minFreePercentage: 0,
      expansion: expect.objectContaining({ enabled: true, capGiB: 512, liftPercentage: 60 }),
    })
  })

  // Each of these parses to a value that silently changes admission or the
  // expansion water level: NaN or 0 rejects every runner, a truncated limit
  // admits almost nothing, a negative floor lets usage pass 100%, and a zero
  // trigger/step/factor would loop resizes or never grow.
  it.each([
    ['RUNNER_DISK_OVERCOMMIT_RATIO', 'abc'],
    ['RUNNER_DISK_OVERCOMMIT_RATIO', '0'],
    ['RUNNER_DISK_OVERCOMMIT_RATIO', '-1'],
    ['RUNNER_DISK_EXPAND_LIMIT_GIB', '1e9'],
    ['RUNNER_DISK_EXPAND_LIMIT_GIB', '0'],
    ['RUNNER_DISK_EXPAND_LIMIT_GIB', '4096.5'],
    ['RUNNER_DISK_MIN_FREE_PERCENTAGE', 'ten'],
    ['RUNNER_DISK_MIN_FREE_PERCENTAGE', '-10'],
    ['RUNNER_DISK_MIN_FREE_PERCENTAGE', '100'],
    ['RUNNER_DISK_EXPANSION_CAP_GIB', '4096.5'],
    ['RUNNER_DISK_EXPANSION_TRIGGER_PERCENT', '0'],
    ['RUNNER_DISK_EXPANSION_STEP_PERCENT', '150'],
    ['RUNNER_DISK_EXPANSION_SAFETY_FACTOR', '0'],
    ['RUNNER_DISK_EXPANSION_GROWTH_WINDOW_HOURS', '4.5'],
    ['RUNNER_DISK_EXPANSION_HEADROOM_FLOOR_GIB', '0'],
    ['RUNNER_DISK_EXPANSION_MAX_PER_WINDOW', '0'],
    ['RUNNER_DISK_EXPANSION_LIFT_PERCENT', '0'],
    ['RUNNER_DISK_EXPANSION_LIFT_PERCENT', '150'],
  ])('rejects %s=%s at boot', (name, value) => {
    expect(() => runnerDiskConfig({ [name]: value })).toThrow(name)
  })
})
