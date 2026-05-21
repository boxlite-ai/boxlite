/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationEmail, OrganizationTier, OrganizationWallet } from '@/billing-api'
import { Invoice, PaginatedInvoices, PaymentUrl } from '@/billing-api/types/Invoice'
import { Tier } from '@/billing-api/types/tier'
import { BoxliteConfiguration } from '@boxlite-ai/api-client/src'
import { http, HttpResponse } from 'msw'

const BILLING_API_URL = 'http://localhost:3000/api/billing'
const API_URL = import.meta.env.VITE_API_URL

// ─── synthetic local-dev fixtures ────────────────────────────────────────
const NOW = new Date()
const _ORG_ID = '00000000-0000-0000-0000-000000000001'
const _USER_ID = '1234'
const _LOCAL_ORG = {
  id: _ORG_ID,
  name: 'Local Dev Org',
  createdBy: _USER_ID,
  personal: true,
  createdAt: NOW,
  updatedAt: NOW,
  suspended: false,
  suspensionReason: null,
  suspendedUntil: null,
  suspendedAt: null,
  telemetryEnabled: true,
  maxConcurrentSandboxes: 100,
  maxConcurrentSnapshotBuildings: 10,
  defaultRegion: 'local',
  role: 'OWNER',
}


export const handlers = [
  http.get(`${API_URL}/config`, async () => {
    // Hardcoded boot config — no real API needed. Points dashboard at the
    // local dex (running inside infra-local on host port 25556) so OIDC
    // login flow can be exercised. Adjust if local stack changes.
    return HttpResponse.json<Partial<BoxliteConfiguration>>({
      version: 'local-dev',
      oidc: {
        issuer: 'http://localhost:25556/dex',
        clientId: 'boxlite',
        audience: 'boxlite',
      },
      linkedAccountsEnabled: false,
      announcements: {},
      proxyTemplateUrl: 'https://{{PORT}}-{{sandboxId}}.proxy.localhost',
      proxyToolboxUrl: 'http://localhost:28080',
      defaultSnapshot: 'ubuntu:22.04',
      dashboardUrl: 'http://localhost:3000',
      maxAutoArchiveInterval: 43200,
      maintananceMode: false,
      environment: 'local',
      billingApiUrl: BILLING_API_URL,
    } as Partial<BoxliteConfiguration>)
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
    })
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

  // ─── core API mocks for "no real API" local-dev flow ─────────────────
  http.get(`${API_URL}/organizations`, async () => {
    return HttpResponse.json([_LOCAL_ORG])
  }),
  http.get(`${API_URL}/organizations/:id`, async ({ params }) => {
    return HttpResponse.json({ ..._LOCAL_ORG, id: params.id })
  }),
  http.get(`${API_URL}/organizations/:id/users`, async () => {
    return HttpResponse.json([])
  }),
  http.get(`${API_URL}/organizations/:id/invitations`, async () => {
    return HttpResponse.json([])
  }),
  http.get(`${API_URL}/users/me/organization-invitations`, async () => {
    return HttpResponse.json([])
  }),
  http.get(`${API_URL}/users/me`, async () => {
    return HttpResponse.json({
      id: _USER_ID,
      email: 'admin@boxlite.dev',
      name: 'Local Admin',
      role: 'OWNER',
      personalOrganizationId: _ORG_ID,
    })
  }),
  http.get(`${API_URL}/regions`, async () => {
    return HttpResponse.json([{ id: 'local', name: 'Local', isDefault: true }])
  }),

  // Catch-all GET for any other /api/* the dashboard probes — return [] for
  // list-like endpoints so providers don't error out. Local-dev convenience.
  http.get(`${API_URL}/*`, async ({ request }) => {
    console.log('[MSW catch-all GET]', request.url)
    return HttpResponse.json([])
  }),

  // Catch-all POST/PUT/DELETE — return {} so mutations don't error.
  http.post(`${API_URL}/*`, async ({ request }) => {
    console.log('[MSW catch-all POST]', request.url)
    return HttpResponse.json({})
  }),
  http.put(`${API_URL}/*`, async ({ request }) => {
    console.log('[MSW catch-all PUT]', request.url)
    return HttpResponse.json({})
  }),
  http.delete(`${API_URL}/*`, async ({ request }) => {
    console.log('[MSW catch-all DELETE]', request.url)
    return HttpResponse.json({})
  }),
]
