// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BillingApiClient, type OrganizationPlan } from '@/billing-api'
import axios, { AxiosError } from 'axios'
const originalAdapter = axios.defaults.adapter
import { SubscriptionCancellationProvider, SubscriptionCancellationAction } from './SubscriptionCancellation'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mocks = vi.hoisted(() => ({ cancel: vi.fn(), save: vi.fn(), receipt: vi.fn() }))
vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({
    billingApi: {
      cancelSubscription: mocks.cancel,
      getCancellation: mocks.receipt,
      saveCancellationFeedback: mocks.save,
      getOrganizationPlan: async () => ({ ...plan, cancelAtPeriodEnd: true }),
    },
  }),
}))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'review-org', name: 'Review Org' },
    authenticatedUserOrganizationMember: { role: 'owner' },
  }),
}))
vi.mock('@/hooks/mutations/useKeepPlanMutation', () => ({
  useKeepPlanMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
let root: Root
let client: QueryClient
const plan: OrganizationPlan = {
  subscriptionId: '20332033-2033-4033-8033-203320332033',
  planId: 'pro',
  planName: 'Pro',
  status: 'active',
  cycleFrom: new Date('2026-11-23'),
  cycleTo: new Date('2026-12-23'),
  includedQuotaCents: 25000,
  quotaConsumedCents: 6250,
  quotaRemainingCents: 18750,
}
function button(text: string) {
  const match = [...document.querySelectorAll('button')].find((node) => node.textContent === text)
  if (!match) throw new Error(`Missing button: ${text}`)
  return match
}
async function click(text: string) {
  await act(async () => {
    button(text).click()
  })
}
function render(value = plan) {
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <SubscriptionCancellationProvider>
          <SubscriptionCancellationAction organizationId="review-org" plan={value} />
        </SubscriptionCancellationProvider>
      </QueryClientProvider>,
    ),
  )
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  mocks.receipt.mockReset().mockRejectedValue(new Error('not found'))
  mocks.cancel.mockReset().mockResolvedValue(undefined)
  mocks.save.mockReset().mockResolvedValue({ saved: true })
  const host = document.createElement('div')
  document.body.append(host)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  root = createRoot(host)
  render()
})
afterEach(() => {
  axios.defaults.adapter = originalAdapter
  act(() => root.unmount())
  document.body.innerHTML = ''
})
describe('subscription cancellation contract', () => {
  it('opens and closes without cancellation or feedback writes', async () => {
    await click('Cancel subscription')
    expect(document.querySelector('[role=dialog]')?.textContent).toContain('Review Org')
    await click('Keep subscription')
    expect(mocks.cancel).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('allows cancellation without optional feedback', async () => {
    await click('Cancel subscription')
    await click('Confirm cancellation')
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(
      'review-org',
      expect.objectContaining({
        subscriptionId: plan.subscriptionId,
        feedbackExpected: false,
        cycleTo: plan.cycleTo.toISOString(),
      }),
    )
    expect(mocks.save).not.toHaveBeenCalled()
    expect(document.querySelector('[role=dialog]')).toBeNull()
  })
  it('keeps the dialog and choices when cancellation fails', async () => {
    mocks.cancel.mockRejectedValueOnce(new Error('failed'))
    await click('Cancel subscription')
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[role=checkbox]')!.click()
    })
    await click('Confirm cancellation')
    expect(document.querySelector('[role=alert]')?.textContent).toContain('Your answers are kept')
    expect(document.querySelector('[role=checkbox]')?.getAttribute('aria-checked')).toBe('true')
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('preserves independent feedback retry after the plan refetch schedules cancellation', async () => {
    mocks.save.mockRejectedValueOnce(new Error('feedback failed'))
    await click('Cancel subscription')
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[role=checkbox]')!.click()
    })
    await click('Confirm cancellation')
    render({ ...plan, cancelAtPeriodEnd: true })
    expect(document.body.textContent).toContain('Cancellation confirmed. Your feedback wasn’t saved.')
    await click('Retry feedback')
    expect(mocks.cancel).toHaveBeenCalledTimes(1)
    expect(mocks.save).toHaveBeenCalledTimes(2)
    expect(mocks.save.mock.calls[1][1]).toBe(mocks.save.mock.calls[0][1])
    expect(document.body.textContent).toContain('feedback has been saved')
  })
  it('keeps one idempotency key when retrying an uncertain cancellation', async () => {
    mocks.cancel.mockRejectedValueOnce(new Error('response lost'))
    await click('Cancel subscription')
    await click('Confirm cancellation')
    await click('Confirm cancellation')
    expect(mocks.cancel.mock.calls[1]).toEqual(mocks.cancel.mock.calls[0])
  })
  it('reconciles a lost cancellation response and still submits feedback', async () => {
    mocks.cancel.mockRejectedValueOnce(new Error('response lost'))
    mocks.receipt.mockResolvedValueOnce({ feedbackState: 'awaiting' })
    await click('Cancel subscription')
    await act(async () => document.querySelector<HTMLButtonElement>('[role=checkbox]')!.click())
    await click('Confirm cancellation')
    expect(mocks.save).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role=dialog]')).toBeNull()
  })
  it('does not let a failed feedback write block another cancellation', async () => {
    mocks.save.mockRejectedValueOnce(new Error('feedback failed'))
    await click('Cancel subscription')
    await act(async () => document.querySelector<HTMLButtonElement>('[role=checkbox]')!.click())
    await click('Confirm cancellation')
    render(plan)
    await click('Cancel subscription')
    expect(document.querySelector('[role=dialog]')).not.toBeNull()
    await click('Confirm cancellation')
    expect(mocks.cancel).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('Retry feedback')
  })
  it('allows a fresh confirmation after the server rejects stale plan details', async () => {
    let attempts = 0
    axios.defaults.adapter = async (config) => {
      if (++attempts === 1)
        throw new AxiosError('stale plan', 'ERR_BAD_REQUEST', config, undefined, {
          status: 409,
          statusText: 'Conflict',
          data: { message: 'Subscription changed' },
          headers: {},
          config,
        })
      return { status: 200, statusText: 'OK', data: { operationId: 'accepted' }, headers: {}, config }
    }
    const api = new BillingApiClient('http://billing.test/api/billing', 'test-token')
    mocks.cancel.mockImplementation(api.cancelSubscription.bind(api))
    await click('Cancel subscription')
    await click('Confirm cancellation')
    await click('Confirm cancellation')
    expect(mocks.receipt).not.toHaveBeenCalled()
    expect(mocks.cancel.mock.calls[1][1].operationId).not.toBe(mocks.cancel.mock.calls[0][1].operationId)
  })
  it('offers a custom reason without collapsing feedback', async () => {
    await click('Cancel subscription')
    expect(document.querySelector('details')).toBeNull()
    const label = [...document.querySelectorAll('label')].find((node) =>
      node.textContent?.includes('Other — tell us more'),
    )!
    await act(async () => label.querySelector<HTMLButtonElement>('[role=checkbox]')!.click())
    const area = document.querySelector('textarea')!
    expect(area.placeholder).toBe('Tell us why you’re canceling.')
    expect(area.maxLength).toBe(1000)
    await click('Confirm cancellation')
    expect(mocks.save).toHaveBeenCalledWith(
      'review-org',
      expect.any(String),
      expect.objectContaining({ version: 1, reasons: ['other'] }),
    )
  })
  it('does not offer cancellation after it is scheduled', () => {
    render({ ...plan, cancelAtPeriodEnd: true })
    expect(document.body.textContent).not.toContain('Cancel subscription')
  })
})
