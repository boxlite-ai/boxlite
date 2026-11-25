// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrganizationPlan } from '@/billing-api'
import { SubscriptionCancellationProvider, SubscriptionCancellationAction } from './SubscriptionCancellation'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  save: vi.fn(),
  read: vi.fn(),
  keep: vi.fn(),
  org: 'review-org',
  role: 'owner',
}))
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
  useKeepPlanMutation: () => ({ mutateAsync: mocks.keep, isPending: false }),
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
function render(value = plan, compact = false) {
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <SubscriptionCancellationProvider>
          <SubscriptionCancellationAction organizationId={mocks.org} plan={value} compact={compact} />
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
  mocks.keep.mockReset().mockResolvedValue(undefined)
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
  it('dismisses the review dialog with Escape without changing renewal', async () => {
    await click('Cancel subscription')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('[role=dialog]')).toBeNull()
    expect(mocks.cancel).not.toHaveBeenCalled()
  })
  it('follows the billing redirect when restoring renewal requires checkout', async () => {
    render({ ...plan, cancelAtPeriodEnd: true }, true)
    const destination = `${window.location.href.split('#')[0]}#restore-checkout`
    mocks.keep.mockResolvedValue(destination)
    await click('Keep subscription')
    expect(window.location.href).toBe(destination)
    window.history.replaceState(null, '', window.location.pathname)
  })
  it('shows the trial end date in the overview cancellation entry', () => {
    render({
      ...plan,
      trial: {
        startedAt: plan.cycleFrom,
        endsAt: plan.cycleTo,
        conversionAmountCents: 14900,
        currency: 'USD',
        conversionState: 'not_attempted',
      },
    })
    expect(document.body.textContent).toContain('Trial ends Dec 23, 2026')
  })
  it.each(['preflight', 'confirmation'] as const)(
    'ignores a late %s read after an organization switch',
    async (stage) => {
      let resolve!: (value: OrganizationPlan) => void
      const response = new Promise<OrganizationPlan>((done) => {
        resolve = done
      })
      if (stage === 'confirmation') mocks.read.mockResolvedValueOnce(plan)
      mocks.read.mockImplementationOnce(() => response)
      await click('Cancel subscription')
      await chooseReason()
      await click('Confirm cancellation')
      mocks.org = 'other-org'
      render()
      await act(async () => resolve({ ...plan, cancelAtPeriodEnd: true }))
      expect(mocks.cancel).toHaveBeenCalledTimes(stage === 'preflight' ? 0 : 1)
      expect(mocks.save).not.toHaveBeenCalled()
      expect(document.body.textContent).not.toContain('Cancellation confirmed')
    },
  )
  it.each([false, true])(
    'does not expose late feedback results in another organization (reject: %s)',
    async (reject) => {
      let finish!: () => void
      mocks.save.mockImplementationOnce(
        () =>
          new Promise<void>((resolve, fail) => {
            finish = () => (reject ? fail(new Error('offline')) : resolve())
          }),
      )
      await click('Cancel subscription')
      await chooseReason()
      await click('Confirm cancellation')
      expect(document.body.textContent).toContain('Cancellation confirmed')
      mocks.org = 'other-org'
      render()
      await act(async () => finish())
      expect(document.body.textContent).not.toContain('feedback has been saved')
      expect(document.body.textContent).not.toContain('Retry feedback')
    },
  )
  it('restores paid renewal from the current plan card and allows retry after failure', async () => {
    render({ ...plan, cancelAtPeriodEnd: true }, true)
    expect(document.body.textContent).toContain('Ends on Dec 23, 2026')
    mocks.keep.mockRejectedValueOnce(new Error('unavailable'))
    await click('Keep subscription')
    expect(document.querySelector('[role=alert]')?.textContent).toContain('Couldn’t restore renewal')
    await click('Keep subscription')
    expect(mocks.keep).toHaveBeenLastCalledWith({ organizationId: 'review-org', planId: 'pro', kind: 'cancel' })
    expect(document.querySelector('[role=alert]')).toBeNull()
    expect(mocks.cancel).not.toHaveBeenCalled()
  })
  it.each(['not_attempted', 'pending'] as const)(
    'explains trial cancellation in state %s without offering unsupported restoration',
    async (conversionState) => {
      const trialPlan = {
        ...plan,
        pendingPlanId: 'team',
        trial: {
          startedAt: plan.cycleFrom,
          endsAt: plan.cycleTo,
          conversionAmountCents: 14900,
          currency: 'USD',
          conversionState,
        },
      } satisfies OrganizationPlan
      render(trialPlan, true)
      await click('Cancel subscription')
      expect(document.body.textContent).toContain(
        conversionState === 'not_attempted'
          ? 'Your trial will not convert to a paid subscription.'
          : 'Trial conversion is already in progress.',
      )
      expect(document.body.textContent).toContain('This replaces your scheduled plan change.')
      await click('Keep subscription')
      render({ ...trialPlan, cancelAtPeriodEnd: true }, true)
      expect(document.body.textContent).toContain('Ends on')
      expect(document.body.textContent).not.toContain('Keep subscription')
    },
  )
  it('recovers a preflight failure without issuing cancellation prematurely', async () => {
    mocks.read.mockRejectedValueOnce(new Error('offline'))
    await click('Cancel subscription')
    await chooseReason()
    await click('Confirm cancellation')
    expect(mocks.cancel).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Your answers are kept')
    await click('Confirm cancellation')
    expect(mocks.save).toHaveBeenCalledWith('review-org', { reasons: ['not_tried'], intent: null, note: '' })
  })
  it('reopens an unresolved cancellation and confirms refreshed canceled status without another POST', async () => {
    mocks.cancel.mockResolvedValue(undefined)
    await click('Cancel subscription')
    await chooseReason()
    await click('Confirm cancellation')
    await click('Close')
    await click('Check cancellation')
    expect(document.querySelector('[role=checkbox]')?.getAttribute('aria-checked')).toBe('true')
    await click('Close')
    await click('Cancel subscription')
    current = { ...plan, status: 'canceled' }
    await click('Check status')
    expect(mocks.cancel).toHaveBeenCalledTimes(1)
    expect(mocks.save).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role=dialog]')).toBeNull()
    render(current, true)
    expect(document.body.textContent).not.toContain('Cancel subscription')
  })
  it('keeps feedback after another save failure and retries only the feedback', async () => {
    mocks.save.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('still offline'))
    await click('Cancel subscription')
    await chooseReason()
    await click('Confirm cancellation')
    await click('Retry feedback')
    expect(document.body.textContent).toContain('Your feedback wasn’t saved')
    await click('Retry feedback')
    expect(document.body.textContent).toContain('Your cancellation feedback has been saved')
    expect(mocks.save).toHaveBeenCalledTimes(3)
    expect(mocks.cancel).toHaveBeenCalledTimes(1)
  })
  it('saves an optional intent alone and respects clearing optional answers', async () => {
    await click('Cancel subscription')
    await chooseReason()
    await chooseReason()
    await act(async () => document.querySelector<HTMLButtonElement>('[role=radio]')!.click())
    await click('Clear selection')
    expect(document.querySelector('[role=radio]')?.getAttribute('aria-checked')).toBe('false')
    await act(async () => document.querySelector<HTMLButtonElement>('[role=radio]')!.click())
    await click('Confirm cancellation')
    expect(mocks.save).toHaveBeenCalledWith('review-org', { reasons: [], intent: 'evaluate', note: '' })
  })
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
