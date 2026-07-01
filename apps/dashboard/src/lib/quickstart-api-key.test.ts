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

  it('appends an incrementing suffix on later attempts', () => {
    expect(buildQuickstartApiKeyName(1)).toBe('sdk-quickstart-2')
    expect(buildQuickstartApiKeyName(2)).toBe('sdk-quickstart-3')
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
      // The default and the first suffix are already taken.
      if (name === 'sdk-quickstart' || name === 'sdk-quickstart-2') {
        throw { cause: { response: { status: 409 } } }
      }
      return { name }
    })
    const result = await createApiKeyWithFallbackName(create)
    expect(seen).toEqual(['sdk-quickstart', 'sdk-quickstart-2', 'sdk-quickstart-3'])
    expect(result).toEqual({ name: 'sdk-quickstart-3' })
  })

  it('propagates a non-conflict error without retrying', async () => {
    const create = vi.fn(async () => {
      throw new Error('boom')
    })
    await expect(createApiKeyWithFallbackName(create)).rejects.toThrow('boom')
    expect(create).toHaveBeenCalledTimes(1)
  })
})
