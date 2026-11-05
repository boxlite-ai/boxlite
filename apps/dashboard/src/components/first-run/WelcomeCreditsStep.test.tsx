// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import WelcomeCreditsStep from './WelcomeCreditsStep'

const billingApi = vi.hoisted(() => ({
  getOrganizationWallet: vi.fn(),
  listAllPaymentMethods: vi.fn(),
  getOrganizationCheckoutUrl: vi.fn(),
  redeemCoupon: vi.fn(),
}))
const membership = vi.hoisted(() => ({ role: 'owner' }))
vi.mock('@/hooks/useApi', () => ({ useApi: () => ({ billingApi }) }))
vi.mock('@/hooks/useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: 'org-1', name: 'Acme', isDefaultForAuthenticatedUser: true },
    authenticatedUserOrganizationMember: membership,
  }),
}))
vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({ billingApiUrl: 'https://billing.example.test' }),
}))
vi.mock('react-oidc-context', () => ({
  useAuth: () => ({ user: { profile: { sub: 'user-1', email_verified: true } } }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const wallet = {
  name: 'Acme',
  balanceCents: 0,
  ongoingBalanceCents: 0,
  creditCardConnected: false,
  creditGrantedCents: 0,
  creditRemainingCents: 0,
}
const checkoutUrl = 'https://checkout.stripe.com/c/pay/cs_test_card'
let root: Root, host: HTMLDivElement, client: QueryClient
let checkoutWindow: { location: { href: string }; close: ReturnType<typeof vi.fn> }
const onContinue = vi.fn()
const onBack = vi.fn()

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.resetAllMocks()
  membership.role = 'owner'
  billingApi.getOrganizationWallet.mockResolvedValue(wallet)
  billingApi.listAllPaymentMethods.mockResolvedValue([])
  billingApi.getOrganizationCheckoutUrl.mockResolvedValue(checkoutUrl)
  checkoutWindow = { location: { href: '' }, close: vi.fn() }
  vi.spyOn(window, 'open').mockReturnValue(checkoutWindow as unknown as Window)
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 300_000 }, mutations: { retry: false } },
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  client.clear()
  host.remove()
  vi.restoreAllMocks()
})

async function eventually(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assertion()
  })
}

function button(text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === text)
}

async function click(text: string) {
  const target = button(text)
  expect(target, `button ${text}`).toBeDefined()
  expect(target!.disabled).toBe(false)
  await act(async () => target!.click())
}

async function mount(expectedButton = 'Verify card & claim $100') {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <WelcomeCreditsStep onBack={onBack} onContinue={onContinue} useCase="coding-agent" />
      </QueryClientProvider>,
    )
  })
  await eventually(() => expect(button(expectedButton)?.disabled).toBe(false))
}

function promoInput() {
  return host.querySelector<HTMLInputElement>('#welcome-promo-code')!
}

async function enterPromo(code: string) {
  const input = promoInput()
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, code)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function focusWindow() {
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
  })
}

it('shows the card offer, promo input and an Explore exit before any payment action', async () => {
  await mount()
  expect(button('Verify card & claim $100')).toBeDefined()
  expect(promoInput()).not.toBeNull()
  expect(button('Explore with BoxLite')).toBeDefined()
  expect(billingApi.getOrganizationCheckoutUrl).not.toHaveBeenCalled()
  expect(billingApi.redeemCoupon).not.toHaveBeenCalled()
  await click('Explore with BoxLite')
  expect(onContinue).toHaveBeenCalledTimes(1)
})

it('lets a member explore without reading or changing organization billing', async () => {
  membership.role = 'member'
  await mount('Explore with BoxLite')
  expect(host.textContent).toContain('Only organization owners can manage billing.')
  expect(button('Verify card & claim $100')).toBeUndefined()
  expect(promoInput()).toBeNull()
  await focusWindow()
  await click('Explore with BoxLite')
  expect(onContinue).toHaveBeenCalledTimes(1)
  expect(billingApi.getOrganizationWallet).not.toHaveBeenCalled()
  expect(billingApi.listAllPaymentMethods).not.toHaveBeenCalled()
  expect(billingApi.getOrganizationCheckoutUrl).not.toHaveBeenCalled()
  expect(billingApi.redeemCoupon).not.toHaveBeenCalled()
})

it('shows the existing default card instead of the first saved payment method', async () => {
  billingApi.getOrganizationWallet.mockResolvedValue({ ...wallet, creditCardConnected: true })
  billingApi.listAllPaymentMethods.mockResolvedValue([
    {
      id: 'card-other',
      isDefault: false,
      paymentProviderType: 'stripe',
      providerMethodId: 'pm_other',
      details: { brand: 'mastercard', last4: '4444' },
    },
    {
      id: 'card-default',
      isDefault: true,
      paymentProviderType: 'stripe',
      providerMethodId: 'pm_default',
      details: { brand: 'visa', last4: '4242' },
    },
  ])
  await mount('Start quickstart')
  expect(host.textContent).toContain('Card connected')
  expect(host.textContent).toContain('visa ending in 4242')
  expect(host.textContent).not.toContain('mastercard ending in 4444')
  expect(button('Verify card & claim $100')).toBeUndefined()
  expect(billingApi.getOrganizationCheckoutUrl).not.toHaveBeenCalled()
  await click('Start quickstart')
  expect(onContinue).toHaveBeenCalledTimes(1)
})

it('uses hosted checkout and confirms a connected card from a fresh wallet read on return', async () => {
  let resolveCheckout!: (url: string) => void
  billingApi.getOrganizationCheckoutUrl.mockReturnValueOnce(
    new Promise<string>((resolve) => {
      resolveCheckout = resolve
    }),
  )
  await mount()
  await click('Verify card & claim $100')
  expect(window.open).toHaveBeenCalledWith('', '_blank')
  expect(checkoutWindow.location.href).toBe('')
  expect(host.querySelector('[role="dialog"]')).toBeNull()
  expect(host.textContent).not.toContain('Save your card')
  expect(host.textContent).not.toContain('Card connected')
  expect(billingApi.getOrganizationCheckoutUrl).toHaveBeenCalledWith('org-1')
  await act(async () => resolveCheckout(checkoutUrl))
  await eventually(() => expect(checkoutWindow.location.href).toBe(checkoutUrl))

  checkoutWindow.close()
  expect(host.textContent).not.toContain('Card connected')
  const readsBeforeReturn = billingApi.getOrganizationWallet.mock.calls.length
  const methodReadsBeforeReturn = billingApi.listAllPaymentMethods.mock.calls.length
  await focusWindow()
  await eventually(() => expect(billingApi.getOrganizationWallet.mock.calls.length).toBeGreaterThan(readsBeforeReturn))
  expect(billingApi.listAllPaymentMethods.mock.calls.length).toBeGreaterThan(methodReadsBeforeReturn)
  expect(host.textContent).not.toContain('Card connected')
  expect(button('Start quickstart')).toBeUndefined()

  billingApi.getOrganizationWallet.mockResolvedValue({ ...wallet, creditCardConnected: true })
  await focusWindow()
  await eventually(() => expect(host.textContent).toContain('Card connected'))
  expect(button('Start quickstart')).toBeDefined()
  expect(host.textContent).not.toContain('Your credits are ready.')
  expect(onContinue).not.toHaveBeenCalled()
  await click('Start quickstart')
  expect(onContinue).toHaveBeenCalledTimes(1)
})

it('offers a card-status retry after a failed return read without treating checkout as success', async () => {
  await mount()
  await click('Verify card & claim $100')
  await eventually(() => expect(checkoutWindow.location.href).toBe(checkoutUrl))
  billingApi.getOrganizationWallet.mockRejectedValueOnce(new Error('Wallet status unavailable'))
  await focusWindow()
  await eventually(() => expect(host.querySelector('[role="alert"]')).not.toBeNull())
  expect(host.textContent).not.toContain('Card connected')
  expect(onContinue).not.toHaveBeenCalled()
  billingApi.getOrganizationWallet.mockResolvedValue({ ...wallet, creditCardConnected: true })
  await click('Check card status')
  await eventually(() => expect(host.textContent).toContain('Card connected'))
})

it('requires a promo code before sending a redemption and clears the error when editing', async () => {
  await mount()
  await click('Redeem')
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Enter a promo code.')
  expect(promoInput().getAttribute('aria-invalid')).toBe('true')
  expect(promoInput().getAttribute('aria-describedby')).toBe('welcome-promo-error')
  expect(billingApi.redeemCoupon).not.toHaveBeenCalled()
  await enterPromo('TeamDiscount')
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(promoInput().getAttribute('aria-invalid')).toBe('false')
  expect(billingApi.redeemCoupon).not.toHaveBeenCalled()
})

it('keeps one redemption in flight when the form is submitted again', async () => {
  let resolveRedemption!: (message: string) => void
  billingApi.redeemCoupon.mockReturnValueOnce(
    new Promise<string>((resolve) => {
      resolveRedemption = resolve
    }),
  )
  await mount()
  await enterPromo('TeamDiscount')
  const form = promoInput().form!
  await click('Redeem')
  await eventually(() => expect(promoInput().disabled).toBe(true))
  expect(button('Redeem')?.disabled).toBe(true)
  expect(button('Please wait…')?.disabled).toBe(true)
  expect(host.querySelector('[role="status"]')?.textContent).toBe('Redeeming your code…')
  await act(async () => {
    form.requestSubmit()
    form.requestSubmit()
  })
  expect(billingApi.redeemCoupon).toHaveBeenCalledTimes(1)
  expect(billingApi.redeemCoupon).toHaveBeenCalledWith('org-1', 'TeamDiscount')
  await act(async () => resolveRedemption('Discount applied.'))
  await eventually(() => expect(host.textContent).toContain('Discount applied.'))
  expect(billingApi.redeemCoupon).toHaveBeenCalledTimes(1)
})

it('redeems the entered code and shows the server message without declaring a credit amount or card connection', async () => {
  const message = 'Promotion accepted for this organization.'
  billingApi.redeemCoupon.mockResolvedValue(message)
  await mount()
  await enterPromo('BoXlite20')
  await click('Redeem')
  await eventually(() => expect(host.textContent).toContain(message))
  expect(billingApi.redeemCoupon).toHaveBeenCalledWith('org-1', 'BoXlite20')
  expect(billingApi.getOrganizationWallet.mock.calls.length).toBeGreaterThan(1)
  expect(host.textContent).not.toContain('$20')
  expect(host.textContent).not.toContain('Your credits are ready.')
  expect(host.textContent).not.toContain('Card connected')
  expect(button('Start quickstart')).toBeDefined()
  expect(onContinue).not.toHaveBeenCalled()
})

it('keeps the entered promo code after a refusal and allows another submission', async () => {
  billingApi.redeemCoupon.mockRejectedValueOnce(new Error('This code is not eligible for this organization.'))
  await mount()
  await enterPromo('TeamDiscount')
  await click('Redeem')
  await eventually(() => expect(host.textContent).toContain('This code is not eligible for this organization.'))
  expect(promoInput().value).toBe('TeamDiscount')
  expect(onContinue).not.toHaveBeenCalled()
  billingApi.redeemCoupon.mockResolvedValue('Discount applied.')
  await click('Redeem')
  await eventually(() => expect(host.textContent).toContain('Discount applied.'))
  expect(billingApi.redeemCoupon).toHaveBeenNthCalledWith(2, 'org-1', 'TeamDiscount')
})
