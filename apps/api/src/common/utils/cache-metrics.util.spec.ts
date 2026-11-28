/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { metrics, trace } from '@opentelemetry/api'
import { recordApiModuleCacheAccess } from './cache-metrics.util'

describe('cache metrics', () => {
  afterEach(() => jest.restoreAllMocks())
  it('records low-cardinality cache outcomes without resource identifiers', () => {
    const add = jest.fn()
    jest.spyOn(metrics, 'getMeter').mockReturnValue({ createCounter: () => ({ add }) } as any)

    recordApiModuleCacheAccess('runner_auth', 'hit')

    expect(add).toHaveBeenCalledWith(1, { cache: 'runner_auth', result: 'hit' })
    expect(add.mock.calls[0][1]).not.toHaveProperty('token')
    expect(add.mock.calls[0][1]).not.toHaveProperty('organizationId')
  })

  it('marks the active span with the same cache outcome', () => {
    const add = jest.fn()
    const setAttributes = jest.fn()
    jest.spyOn(metrics, 'getMeter').mockReturnValue({ createCounter: () => ({ add }) } as any)
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({ setAttributes } as any)

    recordApiModuleCacheAccess('region', 'miss')

    expect(setAttributes).toHaveBeenCalledWith({ 'cache.name': 'region', 'cache.result': 'miss' })
  })
})
