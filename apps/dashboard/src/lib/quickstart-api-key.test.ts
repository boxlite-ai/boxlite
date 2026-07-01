/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_QUICKSTART_API_KEY_NAME,
  buildQuickstartApiKeyName,
  createApiKeyWithFallbackName,
  isApiKeyNameConflict,
  resolveQuickstartApiKeyBaseName,
} from './quickstart-api-key'

describe('resolveQuickstartApiKeyBaseName', () => {
  it('uses the default quickstart name when the input is blank', () => {
    expect(resolveQuickstartApiKeyBaseName('')).toBe(DEFAULT_QUICKSTART_API_KEY_NAME)
    expect(resolveQuickstartApiKeyBaseName('   ')).toBe(DEFAULT_QUICKSTART_API_KEY_NAME)
  })

  it('trims a custom key name', () => {
    expect(resolveQuickstartApiKeyBaseName(' demo key ')).toBe('demo key')
  })
})

describe('buildQuickstartApiKeyName', () => {
  it('uses the base name on the first attempt', () => {
    expect(buildQuickstartApiKeyName()).toBe(DEFAULT_QUICKSTART_API_KEY_NAME)
    expect(buildQuickstartApiKeyName(0, 'demo')).toBe('demo')
  })

  it('appends a short random suffix on later attempts', () => {
    expect(buildQuickstartApiKeyName(1)).toMatch(/^sdk-quickstart-[0-9a-z]{4}$/)
    expect(buildQuickstartApiKeyName(2, 'demo')).toMatch(/^demo-[0-9a-z]{4}$/)
  })
})

describe('isApiKeyNameConflict', () => {
  it('detects a 409 wrapped by the axios interceptor', () => {
    expect(isApiKeyNameConflict({ cause: { response: { status: 409 } } })).toBe(true)
  })

  it('detects a raw 409 and the backend duplicate-name message', () => {
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
  it('uses the default name when no custom name is provided', async () => {
    const create = vi.fn(async (name: string) => ({ name }))
    const result = await createApiKeyWithFallbackName(create)

    expect(result).toEqual({ name: DEFAULT_QUICKSTART_API_KEY_NAME })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('uses the custom base name when provided', async () => {
    const create = vi.fn(async (name: string) => ({ name }))
    const result = await createApiKeyWithFallbackName(create, { baseName: 'demo-key' })

    expect(result).toEqual({ name: 'demo-key' })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('retries with a random suffix on duplicate-name conflicts', async () => {
    const seen: string[] = []
    const create = vi.fn(async (name: string) => {
      seen.push(name)
      if (name === 'demo-key') {
        throw { cause: { response: { status: 409 } } }
      }
      return { name }
    })

    const result = await createApiKeyWithFallbackName(create, { baseName: 'demo-key' })
    expect(seen[0]).toBe('demo-key')
    expect(seen[1]).toMatch(/^demo-key-[0-9a-z]{4}$/)
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
