/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  OrganizationEmail,
  OrganizationPlan,
  OrganizationWallet,
  PaginatedPaymentMethods,
  PaginatedWalletTransactions,
  PaymentMethod,
  UsagePrices,
  WalletTransaction,
} from '@/billing-api'
import { Invoice, PaginatedInvoices } from '@/billing-api/types/Invoice'
import { PaymentUrl } from '@/billing-api/types/OrganizationWallet'
import { Plan } from '@/billing-api/types/Plan'
import type { UsageConcurrencySeriesDto } from '@boxlite-ai/api-client'
import { http, HttpResponse } from 'msw'
import {
  MOCK_BOXES,
  MOCK_ORGANIZATION,
  MOCK_ORGANIZATION_MEMBER,
  MOCK_PAGINATED_BOXES,
  MOCK_VOLUMES,
  MOCK_VOLUME_USAGE,
  buildMockConfig,
} from './fixtures'

const BILLING_API_URL = 'http://localhost:3000/api/billing'
const API_URL = import.meta.env.VITE_API_URL

export const handlers = [
  // Core dashboard surface — fully self-contained so `start:mock` needs no
  // backend and no login (see MockAuthProvider for the fake session).
  http.get(`${API_URL}/config`, () => HttpResponse.json(buildMockConfig(BILLING_API_URL))),
  http.get(`${API_URL}/organizations`, () => HttpResponse.json([MOCK_ORGANIZATION])),
  http.get(`${API_URL}/organizations/:organizationId/concurrency`, ({ request }) => {
    const url = new URL(request.url)
    const to = new Date(url.searchParams.get('to') ?? Date.now())
    const from = new Date(url.searchParams.get('from') ?? to.getTime() - 30 * 86_400_000)
    const dayMs = 86_400_000
    const pointCount = Math.max(2, Math.floor((to.getTime() - from.getTime()) / dayMs) + 1)
    const points = Array.from({ length: pointCount }, (_, index) => {
      const progress = index / (pointCount - 1)
      const wave = Math.sin(progress * Math.PI * 2) * 18
      const capacityRun = Math.max(0, 1 - Math.abs(progress - 0.78) / 0.12) * 55
      return {
        observedAt: new Date(from.getTime() + index * dayMs),
        runningBoxes: Math.max(0, Math.round(48 + wave + capacityRun)),
      }
    })
    points[points.length - 1] = { observedAt: to, runningBoxes: 62 }

    return HttpResponse.json<UsageConcurrencySeriesDto>({
      from,
      to,
      granularity: 'day',
      current: points.at(-1)?.runningBoxes ?? 0,
      points,
    })
  }),
  http.get(`${API_URL}/organizations/:organizationId/users`, () => HttpResponse.json([MOCK_ORGANIZATION_MEMBER])),
  http.get(`${API_URL}/box/paginated`, ({ request }) => {
    // Respect the ?states=… filter so the fleet count cards (running / stopped)
    // show real per-state counts in mock, not just the unfiltered total.
    const searchParams = new URL(request.url).searchParams
    const states = searchParams.getAll('states').flatMap((s) => s.split(','))
    if (states.length === 0) return HttpResponse.json(MOCK_PAGINATED_BOXES)
    const items = MOCK_BOXES.filter((b) => b.state != null && states.includes(b.state))
    const isRunningCount = states.length === 1 && states[0] === 'started' && searchParams.get('limit') === '1'
    if (isRunningCount) return HttpResponse.json({ items: items.slice(0, 1), total: 62, page: 1, totalPages: 62 })
    return HttpResponse.json({ items, total: items.length, page: 1, totalPages: 1 })
  }),
  http.get(`${API_URL}/box/:boxIdOrName`, ({ params }) => {
    const box = MOCK_BOXES.find((b) => b.id === params.boxIdOrName) ?? MOCK_BOXES[0]
    return box ? HttpResponse.json(box) : new HttpResponse(null, { status: 404 })
  }),
  // Network / preview surface. `public` is mutated in place so the detail page
  // reflects the toggle after its query is invalidated, the way it does against
  // a real API.
  http.post(`${API_URL}/box/:boxIdOrName/public/:isPublic`, ({ params }) => {
    const box = MOCK_BOXES.find((b) => b.id === params.boxIdOrName)
    if (!box) return new HttpResponse(null, { status: 404 })
    box.public = params.isPublic === 'true'
    return HttpResponse.json(box)
  }),
  http.get(`${API_URL}/box/:boxIdOrName/ports/:port/preview-url`, ({ params }) => {
    const boxId = String(params.boxIdOrName)
    // Mirrors the real hex-encoded direct-preview host shape. Hand-rolled
    // rather than via Buffer, which does not exist in the browser.
    const encodedBoxId = [...boxId].map((char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    return HttpResponse.json({
      boxId,
      url: `https://${params.port}-d-${encodedBoxId}.proxy.mock.boxlite.ai`,
      token: 'mock0boxauthtoken0000000000000000',
    })
  }),
  http.get(`${API_URL}/box/:boxIdOrName/ports/:port/signed-preview-url`, ({ params, request }) => {
    // The real service only signs the terminal port today; keeping that
    // restriction in mock is what surfaces the fallback message in the UI.
    const port = Number(params.port)
    if (port !== 22222) {
      return HttpResponse.json(
        { statusCode: 400, message: 'Signed port preview is only supported for terminal port 22222' },
        { status: 400 },
      )
    }
    const expiresIn = new URL(request.url).searchParams.get('expiresInSeconds') ?? '60'
    const token = `mock${Math.random().toString(36).slice(2, 14)}`
    return HttpResponse.json({
      boxId: String(params.boxIdOrName),
      port,
      token,
      url: `https://${port}-${token}.proxy.mock.boxlite.ai?ttl=${expiresIn}`,
    })
  }),
  http.post(`${API_URL}/box/:boxIdOrName/ports/:port/signed-preview-url/:token/expire`, () => {
    return new HttpResponse(null, { status: 201 })
  }),
  // Volumes. Deletion mirrors the real service (volume.service.ts:74-113):
  // a volume still mounted by a live box is refused with 409, and a successful
  // delete only moves the row to `pending_delete` — the reconciler finishes it
  // later, so the row must not vanish from the list.
  http.get(`${API_URL}/volumes`, () => HttpResponse.json(MOCK_VOLUMES)),
  http.post(`${API_URL}/volumes`, async ({ request }) => {
    const body = (await request.json()) as { name?: string }
    const created = {
      id: `vol-${Math.abs(Date.now() % 100000000)}`,
      name: body?.name || 'unnamed-volume',
      organizationId: MOCK_ORGANIZATION.id,
      state: 'creating',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    MOCK_VOLUMES.unshift(created as (typeof MOCK_VOLUMES)[number])
    // Creation is asynchronous upstream; become mountable shortly after.
    setTimeout(() => {
      const row = MOCK_VOLUMES.find((v) => v.id === created.id)
      if (row) row.state = 'ready' as (typeof row)['state']
    }, 2500)
    return HttpResponse.json(created, { status: 201 })
  }),
  http.delete(`${API_URL}/volumes/:volumeId`, ({ params }) => {
    const id = String(params.volumeId)
    const inUse = MOCK_VOLUME_USAGE[id] ?? []
    if (inUse.length > 0) {
      return HttpResponse.json(
        {
          statusCode: 409,
          message: `Volume cannot be deleted because it is in use by one or more boxes (e.g. ${inUse[0].boxName})`,
          error: 'Conflict',
        },
        { status: 409 },
      )
    }
    const row = MOCK_VOLUMES.find((v) => v.id === id)
    if (!row) return new HttpResponse(null, { status: 404 })
    row.state = 'pending_delete' as (typeof row)['state']
    return new HttpResponse(null, { status: 204 })
  }),

  http.get(`${API_URL}/shared-regions`, () => HttpResponse.json([])),
  http.get(`${API_URL}/regions`, () => HttpResponse.json([])),
  http.get(`${API_URL}/api-keys`, () => HttpResponse.json([])),
  http.post(`${API_URL}/api-keys`, async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { name?: string }
    return HttpResponse.json({
      name: body?.name || 'mock-key',
      value: 'bxl_sk_mock_0123456789abcdef0123456789abcdef',
      createdAt: new Date(),
      permissions: [],
      expiresAt: null,
    })
  }),
  http.get(`${BILLING_API_URL}/organization/:organizationId/portal-url`, async () => {
    return HttpResponse.json<string>(`${BILLING_API_URL}/portal`)
  }),
  http.get(`${BILLING_API_URL}/usage-prices`, async () => {
    // The live dev response, verbatim — including the fractional cents that make
    // disk $0.00 under whole-cent formatting.
    return HttpResponse.json<UsagePrices>({
      schemaVersion: 1,
      currency: 'USD',
      prices: [
        { code: 'cpu', unit: 'core_hour', unitPriceCents: 5.04 },
        { code: 'gpu', unit: 'gpu_hour', unitPriceCents: 100 },
        { code: 'mem', unit: 'gib_hour', unitPriceCents: 1.44 },
        { code: 'disk', unit: 'gib_hour', unitPriceCents: 0.018 },
      ],
    })
  }),
  http.get(`${BILLING_API_URL}/plan`, async () => {
    // Mirrors the billing service's own standard-plan catalog (Subscription.md
    // v2 §3). Enterprise carries nulls — the contact-sales card, not missing
    // data — and is not self-serve.
    return HttpResponse.json<Plan[]>([
      {
        id: 'starter',
        name: 'Starter',
        priceMonthlyCents: 1_900,
        includedQuotaCents: 3_000,
        concurrencyLimit: 20,
        selfServe: true,
      },
      {
        id: 'pro',
        name: 'Pro',
        priceMonthlyCents: 14_900,
        includedQuotaCents: 25_000,
        concurrencyLimit: 100,
        selfServe: true,
      },
      {
        id: 'max',
        name: 'Max',
        priceMonthlyCents: 49_900,
        includedQuotaCents: 90_000,
        concurrencyLimit: 1_000,
        selfServe: true,
      },
      {
        id: 'enterprise',
        name: 'Enterprise',
        priceMonthlyCents: null,
        includedQuotaCents: null,
        concurrencyLimit: null,
        selfServe: false,
      },
    ])
  }),
  http.get(`${BILLING_API_URL}/organization/:organizationId/wallet`, async () => {
    return HttpResponse.json<OrganizationWallet>({
      balanceCents: 1000,
      ongoingBalanceCents: 1000,
      name: 'Wallet',
      creditCardConnected: true,
      automaticTopUp: undefined,
      creditGrantedCents: 10_000,
      creditRemainingCents: 1_000,
    })
  }),
  http.get(`${BILLING_API_URL}/organization/:organizationId/payment-methods`, async ({ request }) => {
    const url = new URL(request.url)
    const page = parseInt(url.searchParams.get('page') || '1', 10)
    const perPage = Math.min(parseInt(url.searchParams.get('perPage') || '20', 10), 100)
    const paymentMethods: PaymentMethod[] = [
      {
        id: '0f04d55c-7d77-4a19-af78-f4a18b2d5f91',
        isDefault: true,
        paymentProviderType: 'stripe',
        providerMethodId: 'pm_mock_visa',
        details: { brand: 'visa', last4: '4242', expMonth: 8, expYear: 2027 },
      },
      {
        id: 'bce26ca7-771d-47c4-898c-b73c93fd52a7',
        isDefault: false,
        paymentProviderType: 'stripe',
        providerMethodId: 'pm_mock_mastercard',
        details: { brand: 'mastercard', last4: '4444', expMonth: 12, expYear: 2029 },
      },
    ]
    const totalCount = paymentMethods.length
    const totalPages = Math.ceil(totalCount / perPage)
    const start = (page - 1) * perPage

    return HttpResponse.json<PaginatedPaymentMethods>({
      paymentMethods: paymentMethods.slice(start, start + perPage),
      meta: {
        currentPage: page,
        totalPages,
        totalCount,
        nextPage: page < totalPages ? page + 1 : null,
        prevPage: page > 1 ? page - 1 : null,
      },
    })
  }),
  http.get(`${BILLING_API_URL}/organization/:organizationId/plan`, async () => {
    // Mirrors the billing service's own mock seed: pro, a quarter used,
    // pinned mid-cycle so the meter renders deterministically. The real
    // route wraps this in a `plan` key ({} means no live plan), never a
    // bare object or null.
    return HttpResponse.json<{ plan?: OrganizationPlan }>({
      plan: {
        planId: 'pro',
        planName: 'Pro',
        status: 'active',
        cycleFrom: new Date(Date.UTC(2026, 7, 5)),
        cycleTo: new Date(Date.UTC(2026, 8, 5)),
        includedQuotaCents: 25000,
        quotaConsumedCents: 6250,
        quotaRemainingCents: 18750,
      },
    })
  }),
  http.post(`${BILLING_API_URL}/organization/:organizationId/plan/upgrade`, async () => {
    return new HttpResponse(null, { status: 204 })
  }),
  http.post(`${BILLING_API_URL}/organization/:organizationId/plan/downgrade`, async () => {
    return new HttpResponse(null, { status: 204 })
  }),
  http.delete(`${BILLING_API_URL}/organization/:organizationId/plan/pending`, async () => {
    return new HttpResponse(null, { status: 204 })
  }),
  // Deterministic funding series: quota-first against the seeded remaining
  // quota, wallet after — dense buckets so the chart shows honest zeros.
  http.get(`${BILLING_API_URL}/organization/:organizationId/usage/series`, async ({ request }) => {
    const url = new URL(request.url)
    const granularity = url.searchParams.get('granularity') === 'hour' ? 'hour' : 'day'
    const stepMs = granularity === 'hour' ? 3_600_000 : 86_400_000
    const to = Date.parse(url.searchParams.get('to') ?? '') || Date.now()
    const from = Date.parse(url.searchParams.get('from') ?? '') || to - 30 * 86_400_000

    let quotaLeft = 18750
    const buckets = []
    for (let start = from; start + stepMs <= to; start += stepMs) {
      const index = Math.floor(start / stepMs)
      const totalCents = granularity === 'day' ? 420 + ((index * 37) % 350) : 30 + ((index * 13) % 40)
      const quotaCoveredCents = Math.min(totalCents, Math.max(0, quotaLeft))
      quotaLeft -= quotaCoveredCents
      buckets.push({
        from: new Date(start).toISOString(),
        to: new Date(start + stepMs).toISOString(),
        quotaCoveredCents,
        fromWalletCents: totalCents - quotaCoveredCents,
      })
    }
    return HttpResponse.json(buckets)
  }),
  http.get(`${BILLING_API_URL}/organization/:organizationId/email`, async () => {
    return HttpResponse.json<OrganizationEmail[]>([
      {
        email: 'user@example.com',
        verified: true,
        owner: true,
        business: false,
        verifiedAt: new Date(),
      },
    ])
  }),
  http.get(`${BILLING_API_URL}/organization/:organizationId/invoices`, async ({ request }) => {
    const url = new URL(request.url)
    const page = parseInt(url.searchParams.get('page') || '1', 10)
    const perPage = parseInt(url.searchParams.get('perPage') || '50', 10)

    const mockInvoices: Invoice[] = [
      {
        id: 'inv-001',
        number: 'INV-2026-001',
        sequentialId: 1,
        chargedAt: new Date('2026-01-01').toISOString(),
        totalAmountCents: 9847,
        quotaCoveredCents: 8_000,
        voided: false,
      },
      {
        id: 'inv-004',
        number: 'INV-2025-010',
        sequentialId: 10,
        chargedAt: new Date('2025-10-01').toISOString(),
        totalAmountCents: 12150,
        quotaCoveredCents: 12_150,
        voided: false,
      },
      {
        id: 'inv-009',
        number: 'INV-2030-010',
        sequentialId: 10,
        chargedAt: new Date('2025-10-01').toISOString(),
        totalAmountCents: 12150,
        quotaCoveredCents: 10_000,
        voided: true,
      },
      {
        id: 'inv-005',
        number: 'INV-2025-009',
        sequentialId: 9,
        chargedAt: new Date('2025-09-01').toISOString(),
        totalAmountCents: 8900,
        quotaCoveredCents: 0,
        voided: false,
      },
    ]

    const startIndex = (page - 1) * perPage
    const endIndex = startIndex + perPage
    const paginatedItems = mockInvoices.slice(startIndex, endIndex)
    const totalItems = mockInvoices.length
    const totalPages = Math.ceil(totalItems / perPage)

    return HttpResponse.json<PaginatedInvoices>({
      items: paginatedItems,
      totalItems,
      totalPages,
    })
  }),
  http.get(`${BILLING_API_URL}/organization/:organizationId/wallet/transactions`, async ({ request }) => {
    const url = new URL(request.url)
    const page = parseInt(url.searchParams.get('page') || '1', 10)
    const perPage = parseInt(url.searchParams.get('perPage') || '10', 10)
    const settledAt = '2026-08-30T10:00:00.000Z'
    const transactions: WalletTransaction[] = [
      {
        id: 'txn-top-up',
        direction: 'inbound',
        kind: 'purchased',
        status: 'settled',
        source: 'manual',
        amountCents: 10_000,
        name: null,
        subscriptionCreditKind: null,
        createdAt: '2026-08-30T10:00:00.000Z',
        settledAt,
      },
      {
        id: 'txn-auto-top-up',
        direction: 'inbound',
        kind: 'purchased',
        status: 'pending',
        source: 'threshold',
        amountCents: 5_000,
        name: null,
        subscriptionCreditKind: null,
        createdAt: '2026-08-29T10:00:00.000Z',
        settledAt: null,
      },
      {
        id: 'txn-usage',
        direction: 'outbound',
        kind: 'invoiced',
        status: 'settled',
        source: 'interval',
        amountCents: 2_437,
        name: 'Usage settlement INV-2026-001',
        subscriptionCreditKind: null,
        createdAt: '2026-08-28T10:00:00.000Z',
        settledAt,
      },
      {
        id: 'txn-subscription',
        direction: 'inbound',
        kind: 'granted',
        status: 'settled',
        source: 'interval',
        amountCents: 25_000,
        name: 'Pro monthly quota',
        subscriptionCreditKind: 'cycle',
        createdAt: '2026-08-27T10:00:00.000Z',
        settledAt,
      },
      {
        id: 'txn-coupon',
        direction: 'inbound',
        kind: 'granted',
        status: 'settled',
        source: 'manual',
        amountCents: 1_000,
        name: 'Coupon SAVE10',
        subscriptionCreditKind: null,
        createdAt: '2026-08-26T10:00:00.000Z',
        settledAt,
      },
      {
        id: 'txn-upgrade',
        direction: 'inbound',
        kind: 'granted',
        status: 'settled',
        source: 'manual',
        amountCents: 15_000,
        name: 'Pro upgrade quota',
        subscriptionCreditKind: 'upgrade',
        createdAt: '2026-08-25T18:00:00.000Z',
        settledAt,
      },
      {
        id: 'txn-signup',
        direction: 'inbound',
        kind: 'granted',
        status: 'settled',
        source: 'manual',
        amountCents: 2_500,
        name: 'Signup credit',
        subscriptionCreditKind: null,
        createdAt: '2026-08-25T16:00:00.000Z',
        settledAt,
      },
      {
        id: 'txn-goodwill',
        direction: 'inbound',
        kind: 'granted',
        status: 'settled',
        source: 'manual',
        amountCents: 1_500,
        name: 'Goodwill adjustment',
        subscriptionCreditKind: null,
        createdAt: '2026-08-25T14:00:00.000Z',
        settledAt,
      },
      {
        id: 'txn-promotion',
        direction: 'inbound',
        kind: 'granted',
        status: 'settled',
        source: 'manual',
        amountCents: 2_000,
        name: 'Launch promotion',
        subscriptionCreditKind: null,
        createdAt: '2026-08-25T12:00:00.000Z',
        settledAt,
      },
      {
        id: 'txn-restore',
        direction: 'inbound',
        kind: 'granted',
        status: 'settled',
        source: 'manual',
        amountCents: 650,
        name: 'Restored subscription credit for BOX-2026-0002',
        subscriptionCreditKind: 'void_restore',
        createdAt: '2026-08-25T10:00:00.000Z',
        settledAt,
      },
      {
        id: 'txn-restored-funds',
        direction: 'inbound',
        kind: 'granted',
        status: 'settled',
        source: 'manual',
        amountCents: 850,
        name: 'Voided BOX-2026-0002',
        subscriptionCreditKind: null,
        createdAt: '2026-08-25T08:00:00.000Z',
        settledAt,
      },
      {
        id: 'txn-expired',
        direction: 'outbound',
        kind: 'expired',
        status: 'settled',
        source: 'interval',
        amountCents: 3_200,
        name: 'Unused monthly quota',
        subscriptionCreditKind: null,
        createdAt: '2026-08-24T10:00:00.000Z',
        settledAt,
      },
      {
        id: 'txn-failed-top-up',
        direction: 'inbound',
        kind: 'purchased',
        status: 'failed',
        source: 'manual',
        amountCents: 10_000,
        name: null,
        subscriptionCreditKind: null,
        createdAt: '2026-08-23T10:00:00.000Z',
        settledAt: null,
      },
    ]
    const start = (page - 1) * perPage

    return HttpResponse.json<PaginatedWalletTransactions>({
      items: transactions.slice(start, start + perPage),
      totalItems: transactions.length,
      totalPages: Math.ceil(transactions.length / perPage),
    })
  }),
  http.post(`${BILLING_API_URL}/organization/:organizationId/wallet/top-up`, async () => {
    return HttpResponse.json<PaymentUrl>({
      url: `https://checkout.stripe.com/pay/cs_test_${Date.now()}`,
    })
  }),
]
