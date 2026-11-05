// @vitest-environment jsdom
/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import axios, { type InternalAxiosRequestConfig } from 'axios'
import { act, isValidElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { BillingApiClient } from '@/billing-api/billingApiClient'
import { useConnectCard } from './useConnectCard'

let billingApi: BillingApiClient
let organizationId = 'org-1'
vi.mock('./useApi', () => ({ useApi: () => ({ billingApi }) }))
vi.mock('./useSelectedOrganization', () => ({
  useSelectedOrganization: () => ({
    selectedOrganization: { id: organizationId },
    authenticatedUserOrganizationMember: { role: 'owner' },
  }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))

const originalAdapter = axios.defaults.adapter
let current: ReturnType<typeof useConnectCard>
let root: Root
let client: QueryClient
let requests: InternalAxiosRequestConfig[]
let complete: (url: string) => void
let fail: (error: Error) => void
let checkoutWindow: { location: { href: string }; close: ReturnType<typeof vi.fn> }

function Harness() {
  current = useConnectCard()
  return null
}

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    )
  })
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  organizationId = 'org-1'
  requests = []
  axios.defaults.adapter = async (config) => {
    requests.push(config)
    const data = await new Promise<string>((resolve, reject) => {
      complete = resolve
      fail = reject
    })
    return { data, status: 200, statusText: 'OK', headers: {}, config }
  }
  billingApi = new BillingApiClient('https://billing.example.test', 'access-token')
  checkoutWindow = { location: { href: '' }, close: vi.fn() }
  vi.spyOn(window, 'open').mockReturnValue(checkoutWindow as unknown as Window)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  root = createRoot(document.createElement('div'))
  await render()
})

afterEach(async () => {
  await act(async () => root.unmount())
  client.clear()
  axios.defaults.adapter = originalAdapter
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

it('opens Stripe with the selected organization checkout URL after opening a blank tab', async () => {
  let pending!: Promise<void>
  await act(async () => {
    pending = current.connectCard()
    expect(window.open).toHaveBeenCalledWith('', '_blank')
    expect(checkoutWindow.location.href).toBe('')
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(current.isPending).toBe(true)
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({
    method: 'get',
    baseURL: 'https://billing.example.test',
    url: '/organization/org-1/checkout-url',
  })
  expect(requests[0].headers.get('Authorization')).toBe('Bearer access-token')

  await act(async () => {
    complete('https://checkout.stripe.com/c/pay/cs_test_123')
    await pending
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(checkoutWindow.location.href).toBe('https://checkout.stripe.com/c/pay/cs_test_123')
  expect(checkoutWindow.close).not.toHaveBeenCalled()
  expect(current.isPending).toBe(false)
  expect(toast.error).not.toHaveBeenCalled()
  expect(toast.info).not.toHaveBeenCalled()
})

it('closes the blank tab and reports a checkout failure', async () => {
  let pending!: Promise<void>
  await act(async () => {
    pending = current.connectCard()
    await Promise.resolve()
  })
  await act(async () => {
    fail(new Error('Billing unavailable'))
    await pending
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(checkoutWindow.close).toHaveBeenCalledTimes(1)
  expect(checkoutWindow.location.href).toBe('')
  expect(toast.error).toHaveBeenCalledWith('Failed to fetch checkout url', {
    description: expect.stringContaining('Billing unavailable'),
  })
  expect(current.isPending).toBe(false)
})

it('requests the newly selected organization when connecting a card after switching organizations', async () => {
  organizationId = 'org-2'
  await render()
  let pending!: Promise<void>
  await act(async () => {
    pending = current.connectCard()
    await Promise.resolve()
  })
  expect(requests[0].url).toBe('/organization/org-2/checkout-url')
  await act(async () => {
    complete('https://checkout.stripe.com/c/pay/cs_test_other')
    await pending
  })
  expect(checkoutWindow.location.href).toBe('https://checkout.stripe.com/c/pay/cs_test_other')
})

it.each(['success', 'failure'])('settles a checkout %s when the browser blocks the new tab', async (outcome) => {
  vi.mocked(window.open).mockReturnValue(null)
  let pending!: Promise<void>
  await act(async () => {
    pending = current.connectCard()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(current.isPending).toBe(true)
  expect(requests).toHaveLength(1)
  await act(async () => {
    if (outcome === 'success') complete('https://checkout.stripe.com/c/pay/cs_test_blocked')
    else fail(new Error('Billing unavailable'))
    await pending
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(current.isPending).toBe(false)
  expect(checkoutWindow.close).not.toHaveBeenCalled()
  expect(checkoutWindow.location.href).toBe('')
  if (outcome === 'failure') {
    expect(toast.error).toHaveBeenCalledWith('Failed to fetch checkout url', {
      description: expect.stringContaining('Billing unavailable'),
    })
    expect(toast.info).not.toHaveBeenCalled()
  } else expect(toast.error).not.toHaveBeenCalled()
})

it('offers the returned Stripe link when the browser blocks the checkout tab', async () => {
  vi.mocked(window.open).mockReturnValue(null)
  let pending!: Promise<void>
  await act(async () => {
    pending = current.connectCard()
    await Promise.resolve()
  })
  await act(async () => {
    complete('https://checkout.stripe.com/c/pay/cs_test_blocked')
    await pending
  })

  expect(toast.info).toHaveBeenCalledOnce()
  const options = vi.mocked(toast.info).mock.calls[0][1]
  expect(options).toMatchObject({ duration: Infinity, closeButton: true })
  const action = options?.action
  expect(isValidElement(action)).toBe(true)
  if (!isValidElement(action)) throw new Error('Expected a checkout link')
  const host = document.createElement('div')
  const actionRoot = createRoot(host)
  try {
    await act(async () => actionRoot.render(action))
    const link = host.querySelector('a')
    expect(link?.textContent).toBe('Open Stripe')
    expect(link?.href).toBe('https://checkout.stripe.com/c/pay/cs_test_blocked')
    expect(link?.target).toBe('_blank')
    expect(link?.rel).toBe('noopener noreferrer')
  } finally {
    await act(async () => actionRoot.unmount())
  }
  expect(requests).toHaveLength(1)
  expect(toast.error).not.toHaveBeenCalled()
})
