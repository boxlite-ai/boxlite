/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

describe('API module cache configuration', () => {
  const original = process.env.ENABLE_API_MODULE_CACHE

  afterEach(() => {
    if (original === undefined) delete process.env.ENABLE_API_MODULE_CACHE
    else process.env.ENABLE_API_MODULE_CACHE = original
    jest.resetModules()
  })

  function enabled(value?: string): boolean {
    if (value === undefined) delete process.env.ENABLE_API_MODULE_CACHE
    else process.env.ENABLE_API_MODULE_CACHE = value
    jest.resetModules()
    return require('./configuration').configuration.apiModuleCache.enabled
  }

  it('defaults to enabled', () => {
    expect(enabled()).toBe(true)
  })

  it('can be explicitly disabled', () => {
    expect(enabled('false')).toBe(false)
  })

  it('can be explicitly enabled', () => {
    expect(enabled('true')).toBe(true)
  })
})
