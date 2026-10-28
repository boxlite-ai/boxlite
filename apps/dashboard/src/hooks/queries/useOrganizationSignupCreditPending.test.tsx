// @vitest-environment jsdom
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from './queryKeys'
import { nextSignupCreditReadMs, useOrganizationSignupCreditPending } from './useOrganizationSignupCreditPending'

const getSignupCreditDelivery = vi.hoisted(() => vi.fn())
vi.mock('../useApi', () => ({ useApi: () => ({ billingApi: { getSignupCreditDelivery } }) }))
vi.mock('../useConfig', () => ({ useConfig: () => ({ billingApiUrl: 'https://billing.example.test' }) }))

describe('nextSignupCreditReadMs', () => {
  it('backs off across about two minutes of undelivered reads, then stops', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8].map((reads) =>
      nextSignupCreditReadMs({ data: { delivered: false }, dataUpdateCount: reads, status: 'success' }),
    )
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, false])
  })

  it('has nothing to wait for once delivered, before the first answer, or after a failed read', () => {
    expect(nextSignupCreditReadMs({ data: { delivered: true }, dataUpdateCount: 1, status: 'success' })).toBe(false)
    expect(nextSignupCreditReadMs({ data: undefined, dataUpdateCount: 0, status: 'pending' })).toBe(false)
    expect(nextSignupCreditReadMs({ data: { delivered: false }, dataUpdateCount: 1, status: 'error' })).toBe(false)
  })
})

describe('useOrganizationSignupCreditPending', () => {
  let client: QueryClient
  let root: Root
  let pending: boolean | undefined

  function Probe({ enabled }: { enabled: boolean }) {
    pending = useOrganizationSignupCreditPending({ organizationId: 'org-1', enabled })
    return null
  }

  async function render(enabled = true) {
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <Probe enabled={enabled} />
        </QueryClientProvider>,
      ),
    )
    await elapse(0)
  }

  // React Query hands each answer to its observers on a zero-delay timer, and
  // fake timers place one set during a tick 1 ms out: the extra millisecond
  // delivers a read that lands on the last tick.
  async function elapse(ms: number) {
    await act(() => vi.advanceTimersByTimeAsync(ms))
    await act(() => vi.advanceTimersByTimeAsync(1))
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    getSignupCreditDelivery.mockReset()
    pending = undefined
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    root = createRoot(document.createElement('div'))
  })

  afterEach(() => {
    act(() => root.unmount())
    client.clear()
    vi.useRealTimers()
  })

  it('reads again while undelivered, and refreshes the wallet and its ledger as the credit lands', async () => {
    const invalidateQueries = vi.spyOn(client, 'invalidateQueries')
    getSignupCreditDelivery.mockResolvedValueOnce({ delivered: false }).mockResolvedValue({ delivered: true })

    await render()
    expect(getSignupCreditDelivery).toHaveBeenCalledWith('org-1')
    expect(pending).toBe(true)

    await elapse(2_000)
    expect(getSignupCreditDelivery).toHaveBeenCalledTimes(2)
    expect(pending).toBe(false)
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.organization.wallet('org-1') })
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.billing.transactions('org-1') })

    await elapse(60_000)
    expect(getSignupCreditDelivery).toHaveBeenCalledTimes(2)
  })

  it('stops waiting after the read window when the credit never lands', async () => {
    getSignupCreditDelivery.mockResolvedValue({ delivered: false })

    await render()
    await elapse(119_000)
    expect(getSignupCreditDelivery).toHaveBeenCalledTimes(7)
    expect(pending).toBe(true)

    await elapse(1_000)
    expect(getSignupCreditDelivery).toHaveBeenCalledTimes(8)
    expect(pending).toBe(false)

    await elapse(60_000)
    expect(getSignupCreditDelivery).toHaveBeenCalledTimes(8)
  })

  it('stops waiting when a later read fails, rather than polling the error', async () => {
    getSignupCreditDelivery
      .mockResolvedValueOnce({ delivered: false })
      .mockRejectedValue(new Error('Signup credit scheduling is temporarily unavailable'))

    await render()
    expect(pending).toBe(true)

    await elapse(2_000)
    expect(pending).toBe(false)

    await elapse(120_000)
    expect(getSignupCreditDelivery).toHaveBeenCalledTimes(2)
  })

  it('asks nothing when not eligible, and leaves the wallet alone when the credit was already there', async () => {
    await render(false)
    expect(getSignupCreditDelivery).not.toHaveBeenCalled()
    expect(pending).toBe(false)

    const invalidateQueries = vi.spyOn(client, 'invalidateQueries')
    getSignupCreditDelivery.mockResolvedValue({ delivered: true })
    await render()
    expect(pending).toBe(false)
    expect(invalidateQueries).not.toHaveBeenCalled()
  })
})
