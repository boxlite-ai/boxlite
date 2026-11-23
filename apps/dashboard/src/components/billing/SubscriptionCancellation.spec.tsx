// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrganizationPlan } from '@/billing-api'
import { SubscriptionCancellationProvider, SubscriptionCancellationAction } from './SubscriptionCancellation'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mocks = vi.hoisted(() => ({ cancel: vi.fn(), save: vi.fn(), read: vi.fn(), org: 'review-org', role: 'owner' }))
vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({
    saveCancellationFeedback: mocks.save,
    billingApi: { downgradePlan: mocks.cancel, getOrganizationPlan: mocks.read },
  }),
}))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: mocks.org, name: 'Review Org' },
    authenticatedUserOrganizationMember: { role: mocks.role },
  }),
}))
vi.mock('@/hooks/mutations/useKeepPlanMutation', () => ({
  useKeepPlanMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
let root: Root
let client: QueryClient
const plan: OrganizationPlan = {
  planId: 'pro',
  planName: 'Pro',
  status: 'active',
  cycleFrom: new Date('2026-11-23'),
  cycleTo: new Date('2026-12-23'),
  includedQuotaCents: 25000,
  quotaConsumedCents: 6250,
  quotaRemainingCents: 18750,
}
let current: OrganizationPlan | null
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
async function chooseReason() {
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[role=checkbox]')!.click()
  })
}
function render(value = plan) {
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <SubscriptionCancellationProvider>
          <SubscriptionCancellationAction organizationId={mocks.org} plan={value} />
        </SubscriptionCancellationProvider>
      </QueryClientProvider>,
    ),
  )
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  mocks.org = 'review-org'
  mocks.role = 'owner'
  current = { ...plan }
  mocks.read.mockReset().mockImplementation(async () => current)
  mocks.cancel.mockReset().mockImplementation(async () => {
    current = { ...plan, cancelAtPeriodEnd: true }
  })
  mocks.save.mockReset().mockResolvedValue(undefined)
  const host = document.createElement('div')
  document.body.append(host)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  root = createRoot(host)
  render()
})
afterEach(() => {
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
  it('uses existing cancellation without subscription ID or optional feedback', async () => {
    await click('Cancel subscription')
    await click('Confirm cancellation')
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith('review-org', null, 15_000)
    expect(mocks.save).not.toHaveBeenCalled()
    expect(document.querySelector('[role=dialog]')).toBeNull()
    expect(document.body.textContent).toContain('Cancellation confirmed')
  })
  it('keeps answers and checks status without replaying an uncertain cancellation', async () => {
    mocks.cancel.mockRejectedValueOnce(new Error('failed'))
    await click('Cancel subscription')
    await chooseReason()
    await click('Confirm cancellation')
    expect(document.querySelector('[role=alert]')?.textContent).toContain('Your answers are kept')
    expect(document.querySelector('[role=checkbox]')?.getAttribute('aria-checked')).toBe('true')
    expect(mocks.save).not.toHaveBeenCalled()
    await click('Check status')
    expect(mocks.cancel).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('Renewal is still on')
    await click('Confirm cancellation')
    expect(mocks.cancel).toHaveBeenCalledTimes(2)
    expect(mocks.save).toHaveBeenCalledTimes(1)
  })
  it('confirms a lost response through refreshed state and saves feedback', async () => {
    mocks.cancel.mockImplementationOnce(async () => {
      current = { ...plan, cancelAtPeriodEnd: true }
      throw new Error('response lost')
    })
    await click('Cancel subscription')
    await chooseReason()
    await click('Confirm cancellation')
    expect(mocks.cancel).toHaveBeenCalledTimes(1)
    expect(mocks.save).toHaveBeenCalledWith('review-org', { reasons: ['not_tried'], intent: null, note: '' })
    expect(document.querySelector('[role=dialog]')).toBeNull()
  })
  it('does not equate HTTP success or an empty plan with confirmed cancellation', async () => {
    mocks.cancel.mockResolvedValue(undefined)
    await click('Cancel subscription')
    await chooseReason()
    await click('Confirm cancellation')
    expect(document.body.textContent).toContain('could not be confirmed')
    current = null
    await click('Check status')
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.cancel).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role=dialog]')).not.toBeNull()
  })
  it('requires another confirmation after plan terms change', async () => {
    await click('Cancel subscription')
    current = { ...plan, cycleTo: new Date('2027-01-23') }
    await click('Confirm cancellation')
    expect(mocks.cancel).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Your plan changed')
    expect(document.body.textContent).toContain('Jan 23, 2027')
  })
  it('does not claim the preflight read atomically protects a later plan change', async () => {
    mocks.cancel.mockImplementationOnce(async () => {
      current = { ...plan, cycleTo: new Date('2027-01-23'), cancelAtPeriodEnd: true }
    })
    await click('Cancel subscription')
    await chooseReason()
    await click('Confirm cancellation')
    expect(mocks.save).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('could not be confirmed')
    await click('Check status')
    expect(mocks.cancel).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('Your plan changed')
  })
  it('retries feedback independently after the plan is canceled', async () => {
    mocks.save.mockRejectedValueOnce(new Error('feedback failed'))
    await click('Cancel subscription')
    await chooseReason()
    await click('Confirm cancellation')
    render({ ...plan, cancelAtPeriodEnd: true })
    expect(document.body.textContent).toContain('Cancellation confirmed. Your feedback wasn’t saved.')
    await click('Retry feedback')
    expect(mocks.cancel).toHaveBeenCalledTimes(1)
    expect(mocks.save).toHaveBeenCalledTimes(2)
    expect(mocks.save.mock.calls[1]).toEqual(mocks.save.mock.calls[0])
  })
  it('discards older unsaved feedback after another cancellation without answers', async () => {
    mocks.save.mockRejectedValueOnce(new Error('feedback failed'))
    await click('Cancel subscription')
    await chooseReason()
    await click('Confirm cancellation')
    current = { ...plan }
    render(plan)
    await click('Cancel subscription')
    await click('Confirm cancellation')
    expect(mocks.cancel).toHaveBeenCalledTimes(2)
    expect(mocks.save).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).not.toContain('Retry feedback')
  })
  it('offers a custom reason without collapsing feedback', async () => {
    await click('Cancel subscription')
    expect(document.querySelector('details')).toBeNull()
    const label = [...document.querySelectorAll('label')].find((node) =>
      node.textContent?.includes('Other — tell us more'),
    )!
    await act(async () => label.querySelector<HTMLButtonElement>('[role=checkbox]')!.click())
    const area = document.querySelector('textarea')!
    expect(area.maxLength).toBe(1000)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, ' 自定义原因 ')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('Confirm cancellation')
    expect(mocks.save).toHaveBeenCalledWith('review-org', { reasons: ['other'], intent: null, note: '自定义原因' })
  })
  it('ignores late cancellation results after organization switch', async () => {
    let resolve!: () => void
    mocks.cancel.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done
        }),
    )
    await click('Cancel subscription')
    await chooseReason()
    await click('Confirm cancellation')
    mocks.org = 'other-org'
    render()
    await act(async () => {
      current = { ...plan, cancelAtPeriodEnd: true }
      resolve()
    })
    expect(mocks.save).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Cancellation confirmed')
    expect(mocks.read).toHaveBeenCalledTimes(1)
  })
  it('hides the action for members and scheduled cancellation', () => {
    render({ ...plan, cancelAtPeriodEnd: true })
    expect(document.body.textContent).not.toContain('Cancel subscription')
    mocks.role = 'member'
    render(plan)
    expect(document.body.textContent).not.toContain('Cancel subscription')
  })
})
