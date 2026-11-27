/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { metrics } from '@opentelemetry/api'
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
})
