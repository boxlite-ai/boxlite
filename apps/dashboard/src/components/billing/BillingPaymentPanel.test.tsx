// @vitest-environment jsdom
/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BillingPaymentPanel } from './BillingPaymentPanel'

const state = vi.hoisted(() => ({
  paymentMode: 'ready' as 'ready' | 'loading' | 'error',
  receiptsMode: 'ready' as 'ready' | 'loading' | 'error',
  payment: {
    providerMode: 'stripe' as 'fake' | 'stripe',
    paymentMethod: { brand: 'visa', last4: '4242' } as { brand: string; last4: string } | null,
    autoReload: { enabled: true, thresholdCents: '2000', targetCents: '10000' },
  },
  receipts: {
    items: [
      {
        id: 'receipt-top-up',
        createdAt: '2026-07-10T08:00:00.000Z',
        amountCents: '50000',
        type: 'top_up' as const,
        status: 'paid' as const,
        receiptUrl: 'https://billing.test/receipt-top-up',
      },
      {
        id: 'receipt-usage',
        createdAt: '2026-07-09T08:00:00.000Z',
        amountCents: '375',
        type: 'usage' as const,
        status: 'failed' as const,
        receiptUrl: null,
      },
    ],
    page: 1,
    pageSize: 8,
    total: 17,
  },
  paymentRefetch: vi.fn(),
  receiptsRefetch: vi.fn(),
  receiptsQueryArgs: vi.fn(),
  setupPayment: vi.fn(),
  updateAutoReload: vi.fn(),
  createTopUp: vi.fn(),
  redirectToCheckout: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@/hooks/queries/useBillingPaymentQuery', () => ({
  useBillingPaymentQuery: () =>
    state.paymentMode === 'ready'
      ? { data: state.payment, isLoading: false, isError: false, refetch: state.paymentRefetch }
      : {
          data: undefined,
          isLoading: state.paymentMode === 'loading',
          isError: state.paymentMode === 'error',
          refetch: state.paymentRefetch,
        },
}))

vi.mock('@/hooks/queries/useBillingReceiptsQuery', () => ({
  useBillingReceiptsQuery: (args: unknown) => {
    state.receiptsQueryArgs(args)
    return state.receiptsMode === 'ready'
      ? { data: state.receipts, isLoading: false, isError: false, isFetching: false, refetch: state.receiptsRefetch }
      : {
          data: undefined,
          isLoading: state.receiptsMode === 'loading',
          isError: state.receiptsMode === 'error',
          isFetching: false,
          refetch: state.receiptsRefetch,
        }
  },
}))

vi.mock('@/hooks/mutations/useSetupBillingPaymentMutation', () => ({
  useSetupBillingPaymentMutation: () => ({ mutateAsync: state.setupPayment, isPending: false }),
}))

vi.mock('@/hooks/mutations/useUpdateBillingAutoReloadMutation', () => ({
  useUpdateBillingAutoReloadMutation: () => ({ mutateAsync: state.updateAutoReload, isPending: false }),
}))

vi.mock('@/hooks/mutations/useCreateBillingTopUpMutation', () => ({
  useCreateBillingTopUpMutation: () => ({ mutateAsync: state.createTopUp, isPending: false }),
}))

vi.mock('sonner', () => ({
  toast: { success: state.toastSuccess, error: state.toastError },
}))

vi.mock('@/lib/billing-checkout', () => ({
  redirectToBillingCheckout: state.redirectToCheckout,
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

vi.mock('@/components/ui/dialog', () => {
  const Container = ({ children }: { children: ReactNode }) => <>{children}</>
  return {
    Dialog: Container,
    DialogClose: Container,
    DialogContent: Container,
    DialogDescription: Container,
    DialogFooter: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    DialogTrigger: Container,
  }
})

vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: ComponentProps<'button'> & { checked?: boolean; onCheckedChange?: (value: boolean) => void }) => (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onCheckedChange?.(!checked)} {...props} />
  ),
}))

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

async function setInput(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    valueSetter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

describe('BillingPaymentPanel', () => {
  let root: Root | null = null

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    state.paymentMode = 'ready'
    state.receiptsMode = 'ready'
    state.payment.providerMode = 'stripe'
    state.payment.paymentMethod = { brand: 'visa', last4: '4242' }
    state.payment.autoReload = { enabled: true, thresholdCents: '2000', targetCents: '10000' }
    state.receipts.items = [
      {
        id: 'receipt-top-up',
        createdAt: '2026-07-10T08:00:00.000Z',
        amountCents: '50000',
        type: 'top_up',
        status: 'paid',
        receiptUrl: 'https://billing.test/receipt-top-up',
      },
      {
        id: 'receipt-usage',
        createdAt: '2026-07-09T08:00:00.000Z',
        amountCents: '375',
        type: 'usage',
        status: 'failed',
        receiptUrl: null,
      },
    ]
    state.receipts.page = 1
    state.receipts.pageSize = 8
    state.receipts.total = 17
    state.setupPayment.mockReset().mockResolvedValue({ status: 'ready', checkoutUrl: null })
    state.updateAutoReload.mockReset().mockResolvedValue(undefined)
    state.createTopUp.mockReset().mockResolvedValue({ id: 'top-up-1', status: 'paid', checkoutUrl: null })
    state.redirectToCheckout.mockReset()
    state.paymentRefetch.mockReset()
    state.receiptsRefetch.mockReset()
    state.receiptsQueryArgs.mockReset()
    state.toastSuccess.mockReset()
    state.toastError.mockReset()
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  async function renderPanel() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => {
      root = createRoot(host)
      root.render(<BillingPaymentPanel organizationId="org-1" />)
    })
  }

  it('renders only auto-reload, top-up, and API-backed receipt fields', async () => {
    await renderPanel()

    expect(document.querySelector('[data-testid="billing-top-up-panel"]')).toBeTruthy()
    expect(document.querySelector('[data-testid="billing-receipts"]')).toBeTruthy()
    expect(document.body.textContent).toContain('Top-up')
    expect(document.body.textContent).toContain('when balance < $20.00 → top up to $100.00')
    expect(findButton('Edit')).toBeTruthy()
    expect(document.body.textContent).toContain('$500.00')
    expect(document.body.textContent).toContain('$3.75')
    expect(document.body.textContent).toContain('top up')
    expect(document.body.textContent).toContain('usage')
    expect(document.body.textContent).toContain('paid')
    expect(document.body.textContent).toContain('failed')
    expect(document.querySelector('a[href="https://billing.test/receipt-top-up"]')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Payment method')
    expect(document.body.textContent).not.toContain('Set up payment method')
    expect(document.body.textContent?.toLowerCase()).not.toMatch(/due date|overdue|pending invoice|coupon/)
  })

  it('sends receipt search and pagination to the server query', async () => {
    await renderPanel()
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search receipts"]')
    if (!search) throw new Error('Receipt search is missing')

    await setInput(search, 'failed')
    expect(state.receiptsQueryArgs).toHaveBeenLastCalledWith({
      organizationId: 'org-1',
      page: 1,
      pageSize: 8,
      query: 'failed',
    })

    await click(findButton('Next page'))
    expect(state.receiptsQueryArgs).toHaveBeenLastCalledWith({
      organizationId: 'org-1',
      page: 2,
      pageSize: 8,
      query: 'failed',
    })
  })

  it('requires the auto-reload target to be at least ten dollars above the threshold', async () => {
    await renderPanel()
    const threshold = document.querySelector<HTMLInputElement>('input[aria-label="Auto-reload threshold"]')
    const target = document.querySelector<HTMLInputElement>('input[aria-label="Auto-reload target"]')
    if (!threshold || !target) throw new Error('Auto-reload inputs are missing')

    await setInput(threshold, '95')
    await setInput(target, '100')
    expect(document.body.textContent).toContain('Target must be at least $105.00')
    expect(findButton('Save auto-reload').disabled).toBe(true)

    await setInput(target, '105')
    await click(findButton('Save auto-reload'))
    expect(state.updateAutoReload).toHaveBeenCalledWith({
      organizationId: 'org-1',
      autoReload: { enabled: true, thresholdCents: '9500', targetCents: '10500' },
    })
  })

  it('does not create a preset top-up until the second confirmation', async () => {
    await renderPanel()

    await click(findButton('$500'))
    await click(findButton('Top up'))
    expect(state.createTopUp).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Confirm $500.00 top-up')

    await click(findButton('Confirm top-up'))
    expect(state.createTopUp).toHaveBeenCalledWith({ organizationId: 'org-1', amountCents: '50000' })
  })

  it('redirects top-up responses that include checkout URLs', async () => {
    state.createTopUp.mockResolvedValue({
      id: 'top-up-2',
      status: 'pending',
      checkoutUrl: 'https://checkout.test/top-up',
    })
    await renderPanel()
    await click(findButton('$25'))
    await click(findButton('Top up'))
    await click(findButton('Confirm top-up'))

    expect(state.redirectToCheckout).toHaveBeenCalledWith('https://checkout.test/top-up')
  })

  it('requires custom top-ups to be at least five dollars', async () => {
    await renderPanel()
    const customAmount = document.querySelector<HTMLInputElement>('input[aria-label="Custom top-up amount"]')
    if (!customAmount) throw new Error('Custom top-up input is missing')

    await setInput(customAmount, '4.99')
    expect(document.body.textContent).toContain('Minimum top-up is $5.00')
    expect(findButton('Top up').disabled).toBe(true)

    await setInput(customAmount, '5')
    expect(document.body.textContent).not.toContain('Minimum top-up is $5.00')
    expect(findButton('Top up').disabled).toBe(false)
    await click(findButton('Top up'))
    await click(findButton('Confirm top-up'))
    expect(state.createTopUp).toHaveBeenCalledWith({ organizationId: 'org-1', amountCents: '500' })
  })

  it('shows honest payment and receipt empty states without inventing money data', async () => {
    state.payment.paymentMethod = null
    state.payment.autoReload = { enabled: false, thresholdCents: null, targetCents: null }
    state.receipts.items = []
    state.receipts.total = 0
    await renderPanel()

    expect(document.body.textContent).toContain('No receipts found')
    expect(document.body.textContent).toContain('Configure a payment method in Usage')
    expect(document.body.textContent).not.toContain('$0.00')
    expect(document.body.textContent).not.toContain('Set up payment method')
    expect(findButton('Top up').disabled).toBe(true)
  })

  it('keeps payment and receipt request failures separate and retryable', async () => {
    state.paymentMode = 'error'
    state.receiptsMode = 'error'
    await renderPanel()

    expect(document.body.textContent).toContain('Payment settings are unavailable')
    expect(document.body.textContent).toContain('Receipts are unavailable')
    expect(document.body.textContent).not.toContain('$0.00')
    expect(findButton('Retry payment settings')).toBeTruthy()
    expect(findButton('Retry receipts')).toBeTruthy()
  })

  it('keeps dependent controls in a loading state until payment settings resolve', async () => {
    state.paymentMode = 'loading'
    state.receiptsMode = 'loading'
    await renderPanel()

    expect(document.body.textContent).toContain('Loading payment settings')
    expect(document.body.textContent).toContain('Loading receipts')
    expect(document.body.textContent).not.toContain('Payment settings are required')
    expect(document.body.textContent).not.toContain('$0.00')
  })
})
