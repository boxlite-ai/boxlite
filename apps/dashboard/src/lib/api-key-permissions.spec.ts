import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiKeyExpirationDate, apiKeyExpirationLabel, apiKeyPermissionSummary } from './api-key-permissions'

afterEach(() => vi.useRealTimers())

describe('API key inventory labels', () => {
  it.each([
    [[], 'No permissions selected'],
    [['write:boxes', 'write:boxes'], 'Box operations'],
    [['delete:boxes'], 'Delete boxes'],
    [['future:scope'], 'future:scope'],
    [['write:boxes', 'delete:boxes'], 'Boxes · 2 permissions'],
    [['write:boxes', 'read:volumes'], '2 permissions'],
    [['write:boxes', 'future:scope'], '2 permissions'],
  ])('summarizes %j without inflating or concealing grants', (permissions, expected) => {
    expect(apiKeyPermissionSummary(permissions)).toBe(expected)
  })

  it('distinguishes permanent, invalid, expired and future expiration dates', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-16T00:00:00Z'))
    expect(apiKeyExpirationLabel(null)).toBe('No expiration')
    expect(apiKeyExpirationLabel('invalid')).toBe('Unknown expiration')
    expect(apiKeyExpirationLabel('2026-11-16T00:00:00Z')).toBe('Expired')
    expect(apiKeyExpirationLabel('2026-11-16T00:00:01Z')).toBe('In 1 day')
    expect(apiKeyExpirationLabel('2026-11-17T00:00:01Z')).toBe('In 2 days')
    expect(apiKeyExpirationDate(null)).toBe('No expiration')
    expect(apiKeyExpirationDate('2026-11-17T00:00:01Z')).toBe(
      new Date('2026-11-17T00:00:01Z').toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'long' }),
    )
  })
})
