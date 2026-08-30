/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

describe('UsageService drift repair telemetry', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    jest.resetModules()
  })

  it('creates the drift counter lazily and reuses it across service instances', () => {
    jest.resetModules()
    const { metrics } = require('@opentelemetry/api') as typeof import('@opentelemetry/api')
    const add = jest.fn()
    const createCounter = jest.fn().mockReturnValue({ add })
    const getMeter = jest.spyOn(metrics, 'getMeter').mockReturnValue({ createCounter } as any)
    const { UsageService } = require('./usage.service') as typeof import('./usage.service')

    expect(getMeter).not.toHaveBeenCalled()
    expect(createCounter).not.toHaveBeenCalled()

    const makeService = () => new UsageService({} as any, {} as any, {} as any, {} as any, {} as any)
    const firstService = makeService()
    const secondService = makeService()
    const firstWarn = jest.fn()
    const secondWarn = jest.fn()
    ;(firstService as any).logger = { warn: firstWarn }
    ;(secondService as any).logger = { warn: secondWarn }

    expect(getMeter).not.toHaveBeenCalled()
    expect(createCounter).not.toHaveBeenCalled()
    ;(firstService as any).recordDrift('missing', 'box-1')
    ;(secondService as any).recordDrift('orphan', 'box-2')

    expect(getMeter).toHaveBeenCalledTimes(1)
    expect(getMeter).toHaveBeenCalledWith('')
    expect(createCounter).toHaveBeenCalledTimes(1)
    expect(createCounter).toHaveBeenCalledWith('usage_period_drift_repaired', {
      description: 'Open usage periods brought back in step with the box they bill for',
    })
    expect(add).toHaveBeenNthCalledWith(1, 1, { kind: 'missing' })
    expect(add).toHaveBeenNthCalledWith(2, 1, { kind: 'orphan' })
    expect(firstWarn).toHaveBeenCalledWith('Repaired missing usage period drift for box box-1')
    expect(secondWarn).toHaveBeenCalledWith('Repaired orphan usage period drift for box box-2')
  })
})
