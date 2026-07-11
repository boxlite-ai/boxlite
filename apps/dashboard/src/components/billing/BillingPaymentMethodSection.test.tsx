// @vitest-environment jsdom
/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BillingPaymentMethodSection } from './BillingPaymentMethodSection'

const state = vi.hoisted(() => ({
  mode: 'ready' as 'ready' | 'loading' | 'error',
  payment: {
    providerMode: 'stripe' as 'fake' | 'stripe',
    paymentMethod: null as { brand: string; last4: string } | null,
    autoReload: { enabled: false, thresholdCents: null, targetCents: null },
  },
  refetch: vi.fn(),
  setupPayment: vi.fn(),
  addFunds: vi.fn(),
  redirectToCheckout: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@/hooks/queries/useBillingPaymentQuery', () => ({
  useBillingPaymentQuery: () =>
    state.mode === 'ready'
      ? { data: state.payment, isLoading: false, isError: false, refetch: state.refetch }
      : {
          data: undefined,
          isLoading: state.mode === 'loading',
          isError: state.mode === 'error',
          refetch: state.refetch,
        },
}))

vi.mock('@/hooks/mutations/useSetupBillingPaymentMutation', () => ({
  useSetupBillingPaymentMutation: () => ({ mutateAsync: state.setupPayment, isPending: false }),
}))

vi.mock('@/lib/billing-checkout', () => ({
  redirectToBillingCheckout: state.redirectToCheckout,
}))

vi.mock('sonner', () => ({
  toast: { success: state.toastSuccess, error: state.toastError },
}))

vi.mock('@/components/ui/alert-dialog', () => {
  const Container = ({ children }: { children: ReactNode }) => <>{children}</>
  const Button = ({ children, ...props }: ComponentProps<'button'>) => <button {...props}>{children}</button>
  return {
    AlertDialog: Container,
    AlertDialogAction: Button,
    AlertDialogCancel: Button,
    AlertDialogContent: Container,
    AlertDialogDescription: Container,
    AlertDialogFooter: Container,
    AlertDialogHeader: Container,
    AlertDialogTitle: Container,
    AlertDialogTrigger: Container,
  }
})

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!button) throw new Error(`Button not found: ${label}`)
  return button
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click()
    await Promise.resolve()
  })
}

describe('BillingPaymentMethodSection', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    state.mode = 'ready'
    state.payment.providerMode = 'stripe'
    state.payment.paymentMethod = null
    state.refetch.mockReset()
    state.setupPayment.mockReset().mockResolvedValue({ status: 'ready', checkoutUrl: null })
    state.addFunds.mockReset()
    state.redirectToCheckout.mockReset()
    state.toastSuccess.mockReset()
    state.toastError.mockReset()
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  async function renderSection() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host)
      root.render(<BillingPaymentMethodSection organizationId="org-1" onAddFunds={state.addFunds} />)
    })
  }

  it('shows setup only when the Usage balance has no payment method', async () => {
    await renderSection()

    expect(document.body.textContent).toContain('Payment method')
    expect(document.body.textContent).toContain('No payment method configured')
    expect(findButton('Set up payment method')).toBeTruthy()
  })

  it('restores the card-brand row with change-card and add-funds actions', async () => {
    state.payment.paymentMethod = { brand: 'visa', last4: '4242' }
    await renderSection()

    expect(document.querySelector('[data-testid="billing-payment-method-row"]')).toBeTruthy()
    expect(document.body.textContent).toContain('VISA')
    expect(document.body.textContent).toContain('···· 4242')
    expect(document.querySelector('button[aria-label="Change payment method"]')).toBeTruthy()
    await click(findButton('Add funds'))
    expect(state.addFunds).toHaveBeenCalledOnce()
  })

  it('requires confirmation and redirects a setup checkout response', async () => {
    state.setupPayment.mockResolvedValue({ status: 'pending', checkoutUrl: 'https://checkout.test/setup' })
    await renderSection()

    await click(findButton('Set up payment method'))
    expect(state.setupPayment).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain(
      'Stripe securely saves this card for future top-ups. Automatic charges occur only after you enable auto-reload.',
    )
    await click(findButton('Confirm setup'))

    expect(state.setupPayment).toHaveBeenCalledWith({ organizationId: 'org-1' })
    expect(state.redirectToCheckout).toHaveBeenCalledWith('https://checkout.test/setup')
  })

  it('keeps loading and failure states honest and retryable', async () => {
    state.mode = 'loading'
    await renderSection()
    expect(document.body.textContent).toContain('Loading payment settings')
    expect(document.body.textContent).not.toContain('Set up payment method')

    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    state.mode = 'error'
    await renderSection()
    expect(document.body.textContent).toContain('Payment method is unavailable')
    await click(findButton('Retry payment method'))
    expect(state.refetch).toHaveBeenCalledOnce()
  })
})
