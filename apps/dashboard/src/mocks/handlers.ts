/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationEmail, OrganizationTier, OrganizationWallet } from '@/billing-api'
import { Invoice, PaginatedInvoices, PaymentUrl } from '@/billing-api/types/Invoice'
import { Tier } from '@/billing-api/types/tier'
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
  http.get(`${API_URL}/organizations/:organizationId/users`, () => HttpResponse.json([MOCK_ORGANIZATION_MEMBER])),
  http.get(`${API_URL}/box/paginated`, ({ request }) => {
    // Respect the ?states=… filter so the fleet count cards (running / stopped)
    // show real per-state counts in mock, not just the unfiltered total.
    const states = new URL(request.url).searchParams.getAll('states').flatMap((s) => s.split(','))
    if (states.length === 0) return HttpResponse.json(MOCK_PAGINATED_BOXES)
    const items = MOCK_BOXES.filter((b) => b.state != null && states.includes(b.state))
    return HttpResponse.json({ items, total: items.length, page: 1, totalPages: 1 })
  }),
  http.get(`${API_URL}/box/:boxIdOrName`, ({ params }) => {
    const box = MOCK_BOXES.find((b) => b.id === params.boxIdOrName) ?? MOCK_BOXES[0]
    return box ? HttpResponse.json(box) : new HttpResponse(null, { status: 404 })
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
  http.get(`${BILLING_API_URL}/tier`, async () => {
    return HttpResponse.json<Tier[]>([
      {
        tier: 1,
        tierLimit: {
          concurrentCPU: 10,
          concurrentRAMGiB: 20,
          concurrentDiskGiB: 30,
        },
        minTopUpAmountCents: 0,
        topUpIntervalDays: 0,
      },
      {
        tier: 2,
        tierLimit: {
          concurrentCPU: 100,
          concurrentRAMGiB: 200,
          concurrentDiskGiB: 300,
        },
        minTopUpAmountCents: 2500,
        topUpIntervalDays: 0,
      },
      {
        tier: 3,
        tierLimit: {
          concurrentCPU: 250,
          concurrentRAMGiB: 500,
          concurrentDiskGiB: 2000,
        },
        minTopUpAmountCents: 50000,
        topUpIntervalDays: 0,
      },
      {
        tier: 4,
        tierLimit: {
          concurrentCPU: 500,
          concurrentRAMGiB: 1000,
          concurrentDiskGiB: 5000,
        },
        minTopUpAmountCents: 200000,
        topUpIntervalDays: 30,
      },
    ])
  }),
  http.get(`${BILLING_API_URL}/organization/:organizationId/wallet`, async () => {
    return HttpResponse.json<OrganizationWallet>({
      balanceCents: 1000,
      ongoingBalanceCents: 1000,
      name: 'Wallet',
      creditCardConnected: false,
      automaticTopUp: undefined,
      hasFailedOrPendingInvoice: true,
    })
  }),
  http.get(`${BILLING_API_URL}/organization/:organizationId/tier`, async () => {
    return HttpResponse.json<OrganizationTier>({
      tier: 2,
      largestSuccessfulPaymentDate: new Date(),
      largestSuccessfulPaymentCents: 1000,
      expiresAt: new Date(),
      hasVerifiedBusinessEmail: true,
      // Mirrors the billing service's own mock seed: pro, a quarter used,
      // pinned mid-cycle so the meter renders deterministically.
      subscription: {
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
  http.get(`${BILLING_API_URL}/organization/:organizationId/invoices`, async ({ request, params }) => {
    const url = new URL(request.url)
    const page = parseInt(url.searchParams.get('page') || '1', 10)
    const perPage = parseInt(url.searchParams.get('perPage') || '50', 10)

    const mockInvoices: Invoice[] = [
      {
        id: 'inv-001',
        number: 'INV-2026-001',
        currency: 'USD',
        issuingDate: new Date('2026-01-01').toISOString(),
        paymentDueDate: new Date('2026-01-15').toISOString(),
        paymentOverdue: false,
        paymentStatus: 'succeeded',
        sequentialId: 1,
        status: 'finalized',
        totalAmountCents: 9847,
        totalDueAmountCents: 0,
        type: 'subscription',
        fileUrl: 'https://example.com/invoices/inv-001.pdf',
      },
      {
        id: 'inv-004',
        number: 'INV-2025-010',
        currency: 'USD',
        issuingDate: new Date('2025-10-01').toISOString(),
        paymentDueDate: new Date('2025-10-15').toISOString(),
        paymentOverdue: true,
        paymentStatus: 'pending',
        sequentialId: 10,
        status: 'finalized',
        totalAmountCents: 12150,
        totalDueAmountCents: 12150,
        type: 'subscription',
        fileUrl: 'https://example.com/invoices/inv-004.pdf',
      },
      {
        id: 'inv-009',
        number: 'INV-2030-010',
        currency: 'USD',
        issuingDate: new Date('2025-10-01').toISOString(),
        paymentDueDate: new Date('2030-10-15').toISOString(),
        paymentOverdue: false,
        paymentStatus: 'pending',
        sequentialId: 10,
        status: 'pending',
        totalAmountCents: 12150,
        totalDueAmountCents: 12150,
        type: 'subscription',
        fileUrl: 'https://example.com/invoices/inv-004.pdf',
      },
      {
        id: 'inv-005',
        number: 'INV-2025-009',
        currency: 'USD',
        issuingDate: new Date('2025-09-01').toISOString(),
        paymentDueDate: new Date('2025-09-15').toISOString(),
        paymentOverdue: false,
        paymentStatus: 'failed',
        sequentialId: 9,
        status: 'failed',
        totalAmountCents: 8900,
        totalDueAmountCents: 0,
        type: 'add_on',
        fileUrl: 'https://example.com/invoices/inv-005.pdf',
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
  http.post(`${BILLING_API_URL}/organization/:organizationId/invoices/:invoiceId/payment-url`, async () => {
    return HttpResponse.json<PaymentUrl>({
      url: 'https://checkout.stripe.com/pay/cs_test_1234567890',
    })
  }),
  http.post(`${BILLING_API_URL}/organization/:organizationId/invoices/:invoiceId/void`, async () => {
    return HttpResponse.json({})
  }),
  http.post(`${BILLING_API_URL}/organization/:organizationId/wallet/top-up`, async () => {
    return HttpResponse.json<PaymentUrl>({
      url: `https://checkout.stripe.com/pay/cs_test_${Date.now()}`,
    })
  }),
]
