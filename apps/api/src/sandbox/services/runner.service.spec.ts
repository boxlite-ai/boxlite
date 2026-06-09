/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Runner } from '../entities/runner.entity'

/**
 * These tests exercise the Runner entity constructor's supportsSecurityOptions
 * defaulting logic directly — the project symbol under test is Runner's constructor,
 * specifically the `params.supportsSecurityOptions ?? false` expression at line 229.
 *
 * The default is intentionally false: operators must explicitly set
 * supportsSecurityOptions: true when registering a runner binary that handles
 * security payloads.  Auto-promoting unknown runners would silently send security
 * options to runners that may ignore them.
 */
describe('Runner.supportsSecurityOptions v2 default', () => {
  const baseParams = {
    region: 'test-region',
    name: 'test-runner',
    apiVersion: '2',
    apiKey: 'test-api-key',
  }

  it('defaults to false when supportsSecurityOptions is omitted from params', () => {
    // Omitting the field exercises the entity's own `?? false` default.
    const runner = new Runner(baseParams)

    expect(runner.supportsSecurityOptions).toBe(false)
  })

  it('remains false when explicitly set to false', () => {
    const runner = new Runner({ ...baseParams, supportsSecurityOptions: false })

    expect(runner.supportsSecurityOptions).toBe(false)
  })

  it('becomes true when explicitly set to true (operator opt-in)', () => {
    const runner = new Runner({ ...baseParams, supportsSecurityOptions: true })

    expect(runner.supportsSecurityOptions).toBe(true)
  })
})
