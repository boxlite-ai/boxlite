// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxliteError } from '@/api/errors'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BillingOperationTracker } from './billingOperation'

function billingError(status?: number): BoxliteError {
  const cause = Object.assign(new Error(status ? `HTTP ${status}` : 'Network Error'), {
    isAxiosError: true,
    response: status ? { status } : undefined,
  })
  return BoxliteError.fromString(cause.message, { cause })
}

function requireKey(key: string | undefined): string {
  if (!key) {
    throw new Error('Expected the operation tracker to return an idempotency key')
  }
  return key
}

describe('BillingOperationTracker', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    sessionStorage.clear()
  })

  it('blocks a duplicate click while the logical operation is in flight', () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111')
    const tracker = new BillingOperationTracker('wallet-top-up')

    expect(tracker.begin('org-1:5000')).toBe('11111111-1111-4111-8111-111111111111')
    expect(tracker.begin('org-1:5000')).toBeUndefined()
  })

  it('reuses an unresolved in-flight key after a reload without leaving it permanently locked', () => {
    const randomUUID = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('88888888-8888-4888-8888-888888888888')
      .mockReturnValueOnce('99999999-9999-4999-8999-999999999999')
    const firstPage = new BillingOperationTracker('wallet-top-up')
    const firstKey = requireKey(firstPage.begin('org-1:5000'))

    const reloadedPage = new BillingOperationTracker('wallet-top-up')

    expect(reloadedPage.begin('org-1:5000')).toBe(firstKey)
    expect(randomUUID).toHaveBeenCalledTimes(1)
  })

  it('reuses the key for the same operation after an ambiguous response loss', () => {
    const randomUUID = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('22222222-2222-4222-8222-222222222222')
    const tracker = new BillingOperationTracker('redeem-coupon')
    const firstKey = requireKey(tracker.begin('org-1:SAVE10'))

    tracker.fail(firstKey, billingError())

    expect(tracker.begin('org-1:SAVE10')).toBe(firstKey)
    expect(randomUUID).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['input', 'org-1:10000'],
    ['organization', 'org-2:5000'],
  ])('uses a fresh key when the user changes the %s after an ambiguous response loss', (_kind, nextSignature) => {
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('66666666-6666-4666-8666-666666666666')
      .mockReturnValueOnce('77777777-7777-4777-8777-777777777777')
    const tracker = new BillingOperationTracker('wallet-top-up')
    const firstKey = requireKey(tracker.begin('org-1:5000'))

    tracker.fail(firstKey, billingError())

    const reloadedPage = new BillingOperationTracker('wallet-top-up')
    expect(reloadedPage.begin(nextSignature)).toBe('77777777-7777-4777-8777-777777777777')
  })

  it('keeps an unresolved key scoped to its original input when another input completes', () => {
    const randomUUID = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('56565656-5656-4565-8565-565656565656')
      .mockReturnValueOnce('78787878-7878-4787-8787-787878787878')
      .mockReturnValueOnce('90909090-9090-4909-8909-909090909090')
    const tracker = new BillingOperationTracker('wallet-top-up')
    const unresolvedKey = requireKey(tracker.begin('org-1:5000'))
    tracker.fail(unresolvedKey, billingError())

    const changedInputKey = requireKey(tracker.begin('org-1:10000'))
    tracker.succeed(changedInputKey)

    const reloadedPage = new BillingOperationTracker('wallet-top-up')
    expect(reloadedPage.begin('org-1:5000')).toBe(unresolvedKey)
    expect(randomUUID).toHaveBeenCalledTimes(2)
  })

  it('isolates persisted keys by operation kind', () => {
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('12121212-1212-4121-8121-121212121212')
      .mockReturnValueOnce('34343434-3434-4343-8343-343434343434')

    expect(new BillingOperationTracker('wallet-top-up').begin('org-1:value')).toBe(
      '12121212-1212-4121-8121-121212121212',
    )
    expect(new BillingOperationTracker('redeem-coupon').begin('org-1:value')).toBe(
      '34343434-3434-4343-8343-343434343434',
    )
    expect(sessionStorage).toHaveLength(2)
  })

  it.each(['success', 'failure'] as const)('clears persisted state after a definitive %s', (outcome) => {
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('33333333-3333-4333-8333-333333333333')
      .mockReturnValueOnce('44444444-4444-4444-8444-444444444444')
    const tracker = new BillingOperationTracker('wallet-top-up')
    const firstKey = requireKey(tracker.begin('org-1:5000'))

    if (outcome === 'success') {
      tracker.succeed(firstKey)
    } else {
      tracker.fail(firstKey, billingError(400))
    }

    const reloadedPage = new BillingOperationTracker('wallet-top-up')
    expect(reloadedPage.begin('org-1:5000')).toBe('44444444-4444-4444-8444-444444444444')
  })

  it('discards corrupt persisted state and replaces it with a valid operation', () => {
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
      .mockReturnValueOnce('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    const firstPage = new BillingOperationTracker('redeem-coupon')
    firstPage.begin('org-1:SAVE10')
    expect(sessionStorage).toHaveLength(1)
    const storageKey = sessionStorage.key(0)
    if (!storageKey) {
      throw new Error('Expected the tracker to persist an operation')
    }
    sessionStorage.setItem(storageKey, '{not-json')

    const reloadedPage = new BillingOperationTracker('redeem-coupon')

    expect(reloadedPage.begin('org-1:SAVE10')).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    const replacement = sessionStorage.getItem(storageKey)
    expect(replacement).not.toBeNull()
    expect(() => JSON.parse(replacement ?? '')).not.toThrow()
  })

  it('reuses a persisted key only within its bounded lifetime', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-06T00:00:00.000Z'))
    const randomUUID = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('cccccccc-cccc-4ccc-8ccc-cccccccccccc')
      .mockReturnValueOnce('dddddddd-dddd-4ddd-8ddd-dddddddddddd')
    const firstPage = new BillingOperationTracker('wallet-top-up')
    const firstKey = requireKey(firstPage.begin('org-1:5000'))

    vi.advanceTimersByTime(24 * 60 * 60 * 1000 - 1)
    const beforeExpiry = new BillingOperationTracker('wallet-top-up')
    expect(beforeExpiry.begin('org-1:5000')).toBe(firstKey)
    beforeExpiry.fail(firstKey, billingError())

    vi.advanceTimersByTime(2)
    const afterExpiry = new BillingOperationTracker('wallet-top-up')
    expect(afterExpiry.begin('org-1:5000')).toBe('dddddddd-dddd-4ddd-8ddd-dddddddddddd')
    expect(randomUUID).toHaveBeenCalledTimes(2)
  })
})
