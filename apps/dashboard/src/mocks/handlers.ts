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

// Replace all but the first 4 + last 4 chars with `*`, matching how the
// dashboard masks keys in the list view.
function maskKey(v: string): string {
  if (v.length <= 8) return '*'.repeat(v.length)
  return v.slice(0, 4) + '*'.repeat(v.length - 8) + v.slice(-4)
}
const _ORG_ID = '00000000-0000-0000-0000-000000000001'
// Dex wraps static `userID: '1234'` into its connector-prefixed `sub`,
// not the raw "1234". This base64url is what `user.profile.sub` actually
// contains in the dashboard's OIDC session — must match for the
// permission gate to find the member and treat them as OWNER.
const _USER_ID = 'CgQxMjM0EgVsb2NhbA'
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
  // Dashboard checks `!selectedOrganization.defaultRegionId` and shows
  // the "Set Default Region" modal if missing. Set it so we boot directly
  // into Sandboxes without the blocking modal.
  defaultRegionId: 'local',
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

  // Paginated empty-list endpoints — must come BEFORE the GET catch-all.
  // Shape: { items: [], totalItems: 0, totalPages: 0 } expected by
  // `useSandboxes`, `useSnapshots`, etc.
  ...['sandboxes', 'snapshots', 'registries', 'volumes', 'audit-logs',
      'webhooks', 'docker-credentials'].flatMap((resource) => [
    http.get(`${API_URL}/organizations/:orgId/${resource}`, async () =>
      HttpResponse.json({ items: [], totalItems: 0, totalPages: 0 })),
    http.get(`${API_URL}/${resource}`, async () =>
      HttpResponse.json({ items: [], totalItems: 0, totalPages: 0 })),
  ]),

  http.get(`${API_URL}/organizations`, async () => {
    return HttpResponse.json([_LOCAL_ORG])
  }),
  http.get(`${API_URL}/organizations/:id`, async ({ params }) => {
    return HttpResponse.json({ ..._LOCAL_ORG, id: params.id })
  }),
  http.get(`${API_URL}/organizations/:id/users`, async () => {
    // The dashboard's permission system finds the current user via
    // `members.find(m => m.userId === user.profile.sub)`. The OIDC `sub`
    // for our dex static user `admin@boxlite.dev` is "1234" (from
    // SPEC_DEX `userID: '1234'`). Returning OWNER role flips
    // `authenticatedUserHasPermission(...)` to `true` for every check,
    // which unlocks Create buttons on Snapshots, Volumes, Webhooks, etc.
    return HttpResponse.json([
      {
        userId: _USER_ID,
        email: 'admin@boxlite.dev',
        name: 'Local Admin',
        role: 'owner',
        assignedRoles: [{ name: 'Owner', permissions: [] }],
      },
    ])
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
    return HttpResponse.json([])
  }),
  http.get(`${API_URL}/shared-regions`, async () => {
    // Shared regions (the actual endpoint OpenAPI's listSharedRegions hits).
    return HttpResponse.json([
      {
        id: 'local',
        name: 'Local',
        organizationId: null,
        regionType: 'shared',
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        proxyUrl: 'http://localhost:28080',
        sshGatewayUrl: null,
        snapshotManagerUrl: null,
      },
    ])
  }),
  http.patch(`${API_URL}/organizations/:id`, async ({ params, request }) => {
    // Setting default region — accept and echo back.
    const body = await request.json().catch(() => ({}))
    return HttpResponse.json({ ..._LOCAL_ORG, id: params.id, ...(body as object) })
  }),

  // ─── API Keys: stateful CRUD (persisted to sessionStorage) ───────────
  // Survives both Vite HMR of this module AND full page reloads, so
  // create→navigate→delete actually works in the browser. Clears when the
  // browser tab is closed.
  ...((): ReturnType<typeof http.get>[] => {
    type ApiKey = {
      name: string
      userId: string
      value: string
      createdAt: string
      permissions: unknown[]
      expiresAt: string | null
    }
    const KEY = '__msw_api_keys__'
    const load = (): ApiKey[] => {
      try { return JSON.parse(sessionStorage.getItem(KEY) ?? '[]') } catch { return [] }
    }
    const save = (s: ApiKey[]) => sessionStorage.setItem(KEY, JSON.stringify(s))
    return [
      http.get(`${API_URL}/api-keys`, async () =>
        HttpResponse.json(load().map((k) => ({
          userId: _USER_ID,            // fallback for old stored keys
          ...k,
          value: maskKey(k.value),
        })))),
      http.post(`${API_URL}/api-keys`, async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as {
          name?: string
          permissions?: unknown[]
          expiresAt?: string
        }
        const store = load()
        const key: ApiKey = {
          name: body.name ?? `api-key-${store.length + 1}`,
          userId: _USER_ID,
          value: `boxlite_sk_local_${Math.random().toString(36).slice(2, 14)}`,
          createdAt: new Date().toISOString(),
          permissions: body.permissions ?? [],
          expiresAt: body.expiresAt ?? null,
        }
        store.push(key)
        save(store)
        // POST response returns the FULL key value (only chance to see it).
        return HttpResponse.json(key)
      }),
      http.delete(`${API_URL}/api-keys/:name`, async ({ params }) => {
        const store = load().filter((k) => k.name !== params.name)
        save(store)
        return HttpResponse.json({})
      }),
      // Dashboard uses deleteApiKeyForUser → /api-keys/{userId}/{name}
      http.delete(`${API_URL}/api-keys/:userId/:name`, async ({ params }) => {
        const store = load().filter((k) => k.name !== params.name)
        save(store)
        return HttpResponse.json({})
      }),
    ]
  })(),

  // Catch-all GET for any other /api/* the dashboard probes — return shape
  // appropriate to URL:
  //  - URL contains "paginated" -> { items:[], totalItems:0, totalPages:0 }
  //  - else                     -> []
  http.get(`${API_URL}/*`, async ({ request }) => {
    console.log('[MSW catch-all GET]', request.url)
    if (request.url.includes('paginated')) {
      return HttpResponse.json({ items: [], totalItems: 0, totalPages: 0 })
    }
    return HttpResponse.json([])
  }),

  // Catch-all POST/PUT/PATCH/DELETE — return {} so mutations don't error.
  http.post(`${API_URL}/*`, async ({ request }) => {
    console.log('[MSW catch-all POST]', request.url)
    return HttpResponse.json({})
  }),
  http.put(`${API_URL}/*`, async ({ request }) => {
    console.log('[MSW catch-all PUT]', request.url)
    return HttpResponse.json({})
  }),
  http.patch(`${API_URL}/*`, async ({ request }) => {
    console.log('[MSW catch-all PATCH]', request.url)
    return HttpResponse.json({})
  }),
  http.delete(`${API_URL}/*`, async ({ request }) => {
    console.log('[MSW catch-all DELETE]', request.url)
    return HttpResponse.json({})
  }),
]
