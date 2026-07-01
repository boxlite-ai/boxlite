/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { describe, expect, it, vi } from 'vitest'
import { buildQuickstartApiKeyName, createApiKeyWithFallbackName, isApiKeyNameConflict } from './quickstart-api-key'

describe('buildQuickstartApiKeyName', () => {
  it('uses the clean default name on the first attempt', () => {
    expect(buildQuickstartApiKeyName()).toBe('sdk-quickstart')
    expect(buildQuickstartApiKeyName(0)).toBe('sdk-quickstart')
  })

  it('appends a short random suffix on later attempts (never scales with attempt count)', () => {
    const shape = /^sdk-quickstart-[0-9a-z]{8}$/
    expect(buildQuickstartApiKeyName(1)).toMatch(shape)
    expect(buildQuickstartApiKeyName(2)).toMatch(shape)
    expect(buildQuickstartApiKeyName(99)).toMatch(shape)
  })

  it('produces distinct suffixes across calls so retries do not resurface the same 409', () => {
    const samples = new Set(Array.from({ length: 50 }, () => buildQuickstartApiKeyName(1)))
    expect(samples.size).toBeGreaterThan(45)
  })
})

describe('isApiKeyNameConflict', () => {
  it('detects a 409 wrapped by the axios interceptor (BoxliteError.cause.response.status)', () => {
    expect(isApiKeyNameConflict({ cause: { response: { status: 409 } } })).toBe(true)
  })

  it('detects a raw 409 and the backend "already exists" message', () => {
    expect(isApiKeyNameConflict({ response: { status: 409 } })).toBe(true)
    expect(isApiKeyNameConflict(new Error('API key with this name already exists'))).toBe(true)
  })

  it('ignores unrelated errors', () => {
    expect(isApiKeyNameConflict(new Error('network down'))).toBe(false)
    expect(isApiKeyNameConflict({ cause: { response: { status: 500 } } })).toBe(false)
    expect(isApiKeyNameConflict(null)).toBe(false)
  })
})

describe('createApiKeyWithFallbackName', () => {
  it('uses the default name when it is free', async () => {
    const create = vi.fn(async (name: string) => ({ name }))
    const result = await createApiKeyWithFallbackName(create)
    expect(result).toEqual({ name: 'sdk-quickstart' })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('retries with a suffix on a duplicate-name conflict and never throws it', async () => {
    const seen: string[] = []
    const create = vi.fn(async (name: string) => {
      seen.push(name)
      // Only the default is taken; any suffixed name is free.
      if (name === 'sdk-quickstart') throw { cause: { response: { status: 409 } } }
      return { name }
    })
    const result = await createApiKeyWithFallbackName(create)
    expect(seen[0]).toBe('sdk-quickstart')
    expect(seen[1]).toMatch(/^sdk-quickstart-[0-9a-z]{8}$/)
    expect(result).toEqual({ name: seen[1] })
  })

  it('propagates a non-conflict error without retrying', async () => {
    const create = vi.fn(async () => {
      throw new Error('boom')
    })
    await expect(createApiKeyWithFallbackName(create)).rejects.toThrow('boom')
    expect(create).toHaveBeenCalledTimes(1)
  })
})
