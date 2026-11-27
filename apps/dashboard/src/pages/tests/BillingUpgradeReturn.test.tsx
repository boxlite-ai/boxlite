// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { toast } from 'sonner'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BoxliteError } from '@/api/errors'
import FirstBoxWelcome from '@/components/first-run/FirstBoxWelcome'
import { RoutePath } from '@/enums/RoutePath'
import Billing from '../Billing'
import BillingPlanChange from '../BillingPlanChange'

const api = vi.hoisted(() => ({
  getOrganizationCheckoutUrl: vi.fn(),
  getOrganizationOnboarding: vi.fn(),
  getOrganizationPlan: vi.fn(),
  getOrganizationWallet: vi.fn(),
  getPlanTrialEligibility: vi.fn(),
  getUsagePrices: vi.fn(),
  listAllPaymentMethods: vi.fn(),
  listPlans: vi.fn(),
  upgradePlan: vi.fn(),
}))
const viewer = vi.hoisted(() => ({ organizationId: 'org-1', userId: 'user-1', role: 'owner' }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))
vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({ billingApi: api, getOrganizationOnboarding: api.getOrganizationOnboarding }),
}))
vi.mock('@/hooks/useOrganizations', () => ({ useOrganizations: () => ({ refreshOrganizations: vi.fn() }) }))
vi.mock('@/components/first-run/FirstBoxAtmosphere', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock('@/components/first-run/WelcomeJourneyArtwork', () => ({ default: () => null }))
vi.mock('@/hooks/useConfig', () => ({ useConfig: () => ({ billingApiUrl: 'https://billing.example.test' }) }))
vi.mock('react-oidc-context', () => ({
  useAuth: () => ({ user: { profile: { sub: viewer.userId, email_verified: true } } }),
}))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => {
    const member = { organizationId: viewer.organizationId, userId: viewer.userId, role: viewer.role }
    return {
      selectedOrganization: { id: viewer.organizationId, name: 'Acme' },
      authenticatedUserOrganizationMember: member,
      organizationMembers: [member],
      organizationMembersStatus: 'ready',
    }
  },
}))

const pro = {
  id: 'pro',
  name: 'Pro',
  priceMonthlyCents: 14_900,
  includedQuotaCents: 25_000,
  concurrencyLimit: 100,
  selfServe: true,
}
const wallet = { name: 'Acme', balanceCents: 0, ongoingBalanceCents: 0, creditCardConnected: false }
const setupUrl = 'https://checkout.stripe.com/c/pay/cs_test_setup'
const authenticationUrl = 'https://invoice.stripe.com/i/test_authentication'
let location: URL, host: HTMLDivElement, root: Root | undefined, client: QueryClient

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.resetAllMocks()
  Object.assign(viewer, { organizationId: 'org-1', userId: 'user-1', role: 'owner' })
  sessionStorage.clear()
  localStorage.clear()
  api.getOrganizationCheckoutUrl.mockResolvedValue(setupUrl)
  api.getOrganizationOnboarding.mockResolvedValue({ useCase: 'exploring', note: '' })
  api.getOrganizationPlan.mockResolvedValue(null)
  api.getOrganizationWallet.mockResolvedValue(wallet)
  api.getPlanTrialEligibility.mockResolvedValue([{ name: pro.name, eligible: true, durationSeconds: 259_200 }])
  api.listAllPaymentMethods.mockResolvedValue([])
  api.listPlans.mockResolvedValue([pro])
  api.getUsagePrices.mockResolvedValue({ schemaVersion: 1, currency: 'USD', prices: [] })
  api.upgradePlan.mockResolvedValueOnce(setupUrl).mockResolvedValue(undefined)
  location = new URL(window.location.href)
  vi.stubGlobal(
    'window',
    new Proxy(window, {
      get: (target, key) => (key === 'location' ? location : Reflect.get(target, key, target)),
    }),
  )
  host = document.createElement('div')
  document.body.append(host)
})

async function unmount() {
  if (!root) return
  await act(async () => root!.unmount())
  root = undefined
  client.clear()
}

afterEach(async () => {
  await unmount()
  host.remove()
  sessionStorage.clear()
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// A document navigation drops the React tree and its queries but keeps the tab's session storage.
async function visit(path: string) {
  await unmount()
  location = new URL(path, 'https://console.example.test')
  root = createRoot(host)
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  await act(async () =>
    root!.render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path={RoutePath.BILLING_PLAN_CHANGE} element={<BillingPlanChange />} />
              <Route path={RoutePath.BILLING} element={<Billing />} />
              <Route path={RoutePath.WELCOME} element={<FirstBoxWelcome />} />
              <Route path={RoutePath.QUICKSTART} element={<h1>Quickstart</h1>} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </StrictMode>,
    ),
  )
}

async function eventually(assert: () => void, timeout = 1000) {
  await vi.waitFor(
    async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      assert()
    },
    { timeout },
  )
}

async function confirmPlan(expectedUrl = setupUrl) {
  await visit(`${RoutePath.BILLING_PLAN}/pro`)
  const subscribe = () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Subscribe')
  await eventually(() => expect(subscribe()?.disabled).toBe(false))
  await act(async () => subscribe()!.click())
  await eventually(() => expect(location.href).toBe(expectedUrl))
  expect(api.upgradePlan).toHaveBeenCalledExactlyOnceWith('org-1', 'pro')
}

async function returnToBilling() {
  await visit(RoutePath.BILLING)
  await eventually(() => {
    expect(host.querySelector('h1')?.textContent).toBe('Billing')
    expect(client.isFetching()).toBe(0)
    expect(client.isMutating()).toBe(0)
  }, 5000)
}

function connectCard() {
  api.getOrganizationWallet.mockResolvedValue({ ...wallet, creditCardConnected: true })
}

it('submits the confirmed plan once after card setup, including across a Billing reload', async () => {
  await confirmPlan()
  connectCard()
  await returnToBilling()
  await eventually(() =>
    expect(api.upgradePlan.mock.calls).toEqual([
      ['org-1', 'pro'],
      ['org-1', 'pro'],
    ]),
  )
  await returnToBilling()
  expect(api.upgradePlan).toHaveBeenCalledTimes(2)
})

it('leaves a canceled card setup closed when a card is later added independently', async () => {
  await confirmPlan()
  await returnToBilling()
  connectCard()
  await returnToBilling()
  expect(api.upgradePlan).toHaveBeenCalledTimes(1)
}, 10_000)

it('abandons the upgrade when Back restores its confirmation page', async () => {
  await confirmPlan()
  await act(async () => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
  })
  const cancel = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!
  expect(cancel.disabled).toBe(false)
  connectCard()
  await act(async () => cancel.click())
  await eventually(() => expect(host.querySelector('h1')?.textContent).toBe('Billing'))
  expect(api.upgradePlan).toHaveBeenCalledTimes(1)
})

it('does not submit an expired checkout on a later Billing visit', async () => {
  await confirmPlan()
  connectCard()
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 24 * 60 * 60 * 1000)
  await returnToBilling()
  expect(api.upgradePlan).toHaveBeenCalledTimes(1)
})

it('waits for the saved card to become visible before submitting the plan', async () => {
  await confirmPlan()
  let cardConnected = false
  const walletRead = vi.fn(() => Promise.resolve({ ...wallet, creditCardConnected: cardConnected }))
  api.getOrganizationWallet.mockImplementation(walletRead)
  await visit(RoutePath.BILLING)
  await eventually(() => expect(walletRead).toHaveBeenCalled())
  expect(api.upgradePlan).toHaveBeenCalledTimes(1)
  expect(host.querySelector('[role="status"]')?.textContent).toMatch(/checking/i)
  cardConnected = true
  await eventually(() => expect(api.upgradePlan).toHaveBeenCalledTimes(2), 5000)
  expect(api.upgradePlan).toHaveBeenLastCalledWith('org-1', 'pro')
}, 10_000)

it('skips an upgrade when the confirmed plan is already active on return', async () => {
  await confirmPlan()
  connectCard()
  api.getOrganizationPlan.mockResolvedValue({
    planId: pro.id,
    planName: pro.name,
    status: 'active',
    cycleFrom: new Date('2026-11-01'),
    cycleTo: new Date('2026-12-01'),
    includedQuotaCents: 25_000,
    quotaConsumedCents: 0,
    quotaRemainingCents: 25_000,
  })
  await returnToBilling()
  expect(api.upgradePlan).toHaveBeenCalledTimes(1)
})

it('follows the resumed payment authentication URL without submitting again on its return', async () => {
  api.upgradePlan.mockResolvedValueOnce(authenticationUrl)
  await confirmPlan()
  connectCard()
  await visit(RoutePath.BILLING)
  await eventually(() => expect(location.href).toBe(authenticationUrl))
  await returnToBilling()
  expect(api.upgradePlan).toHaveBeenCalledTimes(2)
})

it('keeps an existing-card payment authentication separate from card setup', async () => {
  connectCard()
  api.upgradePlan.mockReset().mockResolvedValueOnce(authenticationUrl)
  await confirmPlan(authenticationUrl)
  await returnToBilling()
  expect(api.upgradePlan).toHaveBeenCalledTimes(1)
})

it.each([
  ['getOrganizationPlan', 1],
  ['upgradePlan', 2],
] as const)('shows a %s failure and leaves any further submission to the owner', async (operation, expectedCalls) => {
  await confirmPlan()
  connectCard()
  api[operation].mockRejectedValueOnce(new BoxliteError('Billing request failed'))
  await returnToBilling()
  await eventually(() => expect(toast.error).toHaveBeenCalled())
  await returnToBilling()
  expect(api.upgradePlan).toHaveBeenCalledTimes(expectedCalls)
})

it.each([
  ['organizationId', 'org-2'],
  ['userId', 'user-2'],
  ['role', 'member'],
] as const)('does not submit across a change in %s', async (field, value) => {
  await confirmPlan()
  connectCard()
  viewer[field] = value
  await returnToBilling()
  expect(api.upgradePlan).toHaveBeenCalledTimes(1)
})

it('opens ordinary Billing with a connected card without submitting an upgrade', async () => {
  connectCard()
  await returnToBilling()
  expect(api.upgradePlan).not.toHaveBeenCalled()
})

const welcomeProgressKey = 'boxlite:welcome:user-1:org-1'

async function chooseWelcomePlan() {
  await visit(RoutePath.WELCOME)
  const choose = () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Choose Pro')
  await eventually(() => {
    expect(choose()).toBeDefined()
    expect(host.textContent).toContain('3 days free')
  })
  await act(async () => choose()!.click())
  await eventually(() => expect(host.querySelector('h1')?.textContent).toBe('Subscribe'))
  expect(api.getOrganizationCheckoutUrl).not.toHaveBeenCalled()
  expect(api.upgradePlan).not.toHaveBeenCalled()
}

async function subscribeFromWelcome() {
  const subscribe = () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Subscribe')
  await eventually(() => expect(subscribe()?.disabled).toBe(false))
  await act(async () => subscribe()!.click())
}

function activatePlan(status: 'active' | 'past_due' = 'active') {
  api.getOrganizationPlan.mockResolvedValue({
    planId: pro.id,
    planName: pro.name,
    status,
    cycleFrom: new Date('2026-11-01'),
    cycleTo: new Date('2026-12-01'),
    includedQuotaCents: pro.includedQuotaCents,
    quotaConsumedCents: 0,
    quotaRemainingCents: pro.includedQuotaCents,
  })
}

async function expectWelcomeCompleted() {
  await eventually(() => expect(host.querySelector('h1')?.textContent).toBe('Quickstart'))
  expect(JSON.parse(localStorage.getItem(welcomeProgressKey)!)).toMatchObject({ completedAt: expect.any(Number) })
}

it('Welcome subscription confirms the paid terms before card setup and submits exactly once after verification', async () => {
  api.listPlans.mockResolvedValue([{ ...pro, priceMonthlyCents: 14_925 }])
  api.upgradePlan.mockReset().mockImplementation(async () => {
    activatePlan()
  })
  await chooseWelcomePlan()
  await eventually(() => expect(host.textContent).toContain('$149.25 at activation if a trial does not apply'))
  await subscribeFromWelcome()
  await eventually(() => expect(location.href).toBe(setupUrl))
  expect(api.getOrganizationCheckoutUrl).toHaveBeenCalledExactlyOnceWith('org-1')
  expect(api.upgradePlan).not.toHaveBeenCalled()
  expect(localStorage.getItem(welcomeProgressKey)).toBeNull()

  connectCard()
  await visit(RoutePath.BILLING)
  await expectWelcomeCompleted()
  await returnToBilling()
  expect(api.upgradePlan).toHaveBeenCalledExactlyOnceWith('org-1', pro.id)
})

it('Welcome subscription with a saved card completes after the immediate subscription succeeds', async () => {
  connectCard()
  api.upgradePlan.mockReset().mockImplementation(async () => {
    activatePlan()
  })
  await chooseWelcomePlan()
  await subscribeFromWelcome()
  await expectWelcomeCompleted()
  expect(api.upgradePlan).toHaveBeenCalledExactlyOnceWith('org-1', pro.id)
  expect(api.getOrganizationCheckoutUrl).not.toHaveBeenCalled()
})

it.each([true, false])(
  'Welcome subscription checks bank authentication without resubmitting, cardless=%s',
  async (cardless) => {
    const opaqueUrl = 'https://checkout.stripe.com/c/pay/opaque_return'
    api.getOrganizationCheckoutUrl.mockResolvedValue(opaqueUrl)
    api.upgradePlan.mockReset().mockResolvedValue(opaqueUrl)
    if (!cardless) connectCard()
    await chooseWelcomePlan()
    await subscribeFromWelcome()
    await eventually(() => expect(location.href).toBe(opaqueUrl))
    if (cardless) {
      expect(api.upgradePlan).not.toHaveBeenCalled()
      connectCard()
      await visit(RoutePath.BILLING)
      await eventually(() => expect(location.href).toBe(opaqueUrl))
    }
    expect(localStorage.getItem(welcomeProgressKey)).toBeNull()
    activatePlan()
    await visit(RoutePath.BILLING)
    await expectWelcomeCompleted()
    expect(api.upgradePlan).toHaveBeenCalledExactlyOnceWith('org-1', pro.id)
  },
)

it.each(['price change', 'canceled card setup', 'different plan'])(
  'Welcome subscription abandons the handoff after %s',
  async (reason) => {
    await chooseWelcomePlan()
    await subscribeFromWelcome()
    await eventually(() => expect(location.href).toBe(setupUrl))
    if (reason !== 'canceled card setup') connectCard()
    if (reason === 'price change') api.listPlans.mockResolvedValue([{ ...pro, priceMonthlyCents: 15_000 }])
    if (reason === 'different plan') api.getOrganizationPlan.mockResolvedValue({ planId: 'another', status: 'active' })
    await visit(RoutePath.BILLING)
    await eventually(() => expect(host.querySelector('[aria-label="Onboarding progress"]')).not.toBeNull(), 5_000)
    expect(api.upgradePlan).not.toHaveBeenCalled()
    expect(localStorage.getItem(welcomeProgressKey)).toBeNull()
  },
)

it('Welcome subscription leaves a payment that is still past due in Billing', async () => {
  connectCard()
  api.upgradePlan.mockReset().mockResolvedValue(authenticationUrl)
  await chooseWelcomePlan()
  await subscribeFromWelcome()
  await eventually(() => expect(location.href).toBe(authenticationUrl))
  activatePlan('past_due')
  await returnToBilling()
  expect(api.upgradePlan).toHaveBeenCalledExactlyOnceWith('org-1', pro.id)
  expect(localStorage.getItem(welcomeProgressKey)).toBeNull()
})

it('Welcome subscription does not continue if the organization changed during setup', async () => {
  await chooseWelcomePlan()
  await subscribeFromWelcome()
  await eventually(() => expect(location.href).toBe(setupUrl))
  connectCard()
  viewer.organizationId = 'org-2'
  await returnToBilling()
  expect(api.upgradePlan).not.toHaveBeenCalled()
  expect(localStorage.getItem(welcomeProgressKey)).toBeNull()
  expect(localStorage.getItem('boxlite:welcome:user-1:org-2')).toBeNull()
})
