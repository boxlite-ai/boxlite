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
import { PaymentUrl, SignupCreditDelivery } from '@/billing-api/types/OrganizationWallet'
import { Plan } from '@/billing-api/types/Plan'
import {
  BoxProgressPhase,
  BoxState,
  NetworkMode,
  RegistryCredentialKind,
  type UsageConcurrencySeriesDto,
} from '@boxlite-ai/api-client'
import { catalogNameOf } from '@/lib/image-ref'
import { http, HttpResponse } from 'msw'
import {
  MOCK_BOXES,
  MOCK_IMAGE_DETAILS,
  MOCK_IMAGE_LIMIT,
  MOCK_ORGANIZATION,
  MOCK_ORGANIZATION_MEMBER,
  MOCK_PAGINATED_BOXES,
  MOCK_REGISTRY_CREDENTIALS,
  buildBox,
  registerImageFromBox,
  MOCK_VOLUMES,
  MOCK_VOLUME_USAGE,
  buildInvoiceHistory,
  buildMockConfig,
  buildWalletHistory,
  newestFirst,
} from './fixtures'

const BILLING_API_URL = 'http://localhost:3000/api/billing'
const API_URL = import.meta.env.VITE_API_URL

// Quickstart's agent handoff waits for a box created after it handed the key
// over, then for that box enabling inbound access. Static fixtures can reach neither
// stage, so both are exposed behind a switch that is off by default:
//   localStorage['qs-publish-demo'] = 'created' | 'published'
function quickstartHandoffDemoBox() {
  const stage = globalThis.localStorage?.getItem('qs-publish-demo')
  if (stage !== 'created' && stage !== 'published') return null
  return {
    ...MOCK_BOXES[0],
    id: 'mock-box-agent',
    name: 'agile-otter',
    createdAt: new Date().toISOString(),
    network: {
      outbound: { mode: NetworkMode.ENABLED, allow_net: [] },
      inbound: { mode: stage === 'published' ? NetworkMode.ENABLED : NetworkMode.DISABLED, allow_net: [] },
    },
  }
}

// Every signup credit reads as delivered. To watch the Wallet tab's pending
// notice come and go, localStorage['signup-credit-pending'] = '1' answers
// false for six seconds from the first read.
let signupCreditFirstReadAt: number | undefined
function signupCreditDelivered() {
  if (globalThis.localStorage?.getItem('signup-credit-pending') !== '1') return true
  signupCreditFirstReadAt ??= Date.now()
  return Date.now() - signupCreditFirstReadAt >= 6_000
}

/** Boxes that block an image's removal: every one not destroyed, as the API counts them. */
function boxesReferencing(imageName: string) {
  return MOCK_BOXES.filter(
    (box) => box.desiredState !== 'destroyed' && box.image != null && catalogNameOf(box.image) === imageName,
  )
}

/** Boxes whose image a credential covers, which block the credential's removal. */
function boxesPullingThrough(credential: { registryHost: string; repositoryPrefix: string }) {
  return MOCK_BOXES.filter((box) => {
    if (box.desiredState === 'destroyed' || !box.image) return false
    const name = catalogNameOf(box.image)
    const [host, ...rest] = name.split('/')
    return host === credential.registryHost && `${rest.join('/')}/`.startsWith(credential.repositoryPrefix)
  })
}

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
    // A brand-new account has no boxes, which static fixtures cannot show;
    // `localStorage['qs-empty-demo'] = '1'` empties the list for that screen.
    if (globalThis.localStorage?.getItem('qs-empty-demo') === '1') {
      return HttpResponse.json({ ...MOCK_PAGINATED_BOXES, items: [], total: 0 })
    }
    if (states.length === 0) {
      const agentBox = quickstartHandoffDemoBox()
      if (!agentBox) return HttpResponse.json(MOCK_PAGINATED_BOXES)
      const items = [agentBox, ...MOCK_PAGINATED_BOXES.items]
      return HttpResponse.json({ ...MOCK_PAGINATED_BOXES, items, total: items.length })
    }
    const items = MOCK_BOXES.filter((b) => b.state != null && states.includes(b.state))
    const isRunningCount = states.length === 1 && states[0] === 'started' && searchParams.get('limit') === '1'
    if (isRunningCount) return HttpResponse.json({ items: items.slice(0, 1), total: 62, page: 1, totalPages: 62 })
    return HttpResponse.json({ items, total: items.length, page: 1, totalPages: 1 })
  }),
  // The Box API's create, which the New Box dialog calls on the page's own
  // origin. The box pulls for a moment, then starts; reaching STARTED is what
  // puts its image in the catalog, as the API's registrar does.
  http.post('*/v1/:organizationId/boxes', async ({ request }) => {
    const body = (await request.json()) as { name?: string; image?: string; cpus?: number; memory_mib?: number }
    const image = body.image || 'ghcr.io/boxlite-ai/boxlite-agent-base:mock'
    const id = `mock-box-${Math.abs(Date.now() % 100000000)}`
    const box = buildBox({
      id,
      name: body.name || `box-${id.slice(-5)}`,
      state: BoxState.CREATING,
      image,
      cpu: body.cpus ?? 1,
      memory: body.memory_mib ? body.memory_mib / 1024 : 1,
      progress: { phase: BoxProgressPhase.PREPARING_IMAGE, retryAfterMs: 5000 },
    })
    MOCK_BOXES.unshift(box)
    MOCK_PAGINATED_BOXES.items = MOCK_BOXES
    MOCK_PAGINATED_BOXES.total = MOCK_BOXES.length
    setTimeout(() => {
      box.state = BoxState.STARTED
      box.progress = undefined
      registerImageFromBox(image)
    }, 4000)
    return HttpResponse.json(
      {
        box_id: id,
        name: box.name,
        status: 'creating',
        created_at: box.createdAt,
        updated_at: box.updatedAt,
        image,
        cpus: box.cpu,
        memory_mib: (box.memory ?? 1) * 1024,
        labels: {},
        auto_stop: 0,
        auto_delete: 0,
      },
      { status: 201 },
    )
  }),
  http.post('*/v1/:organizationId/boxes/:boxId/start', () => new HttpResponse(null, { status: 204 })),
  http.get(`${API_URL}/box/:boxIdOrName`, ({ params }) => {
    const demo = quickstartHandoffDemoBox()
    const box =
      (demo && demo.id === params.boxIdOrName ? demo : undefined) ??
      MOCK_BOXES.find((b) => b.id === params.boxIdOrName) ??
      MOCK_BOXES[0]
    return box ? HttpResponse.json(box) : new HttpResponse(null, { status: 404 })
  }),

  // Network / preview surface. `network.inbound` is mutated in place so the
  // detail page reflects the toggle after its query is invalidated, the way it
  // does against a real API.
  http.put(`${API_URL}/v1/:prefix/boxes/:boxId/network/inbound`, async ({ params, request }) => {
    const box = MOCK_BOXES.find((b) => b.id === params.boxId)
    if (!box?.network) return new HttpResponse(null, { status: 404 })
    const { mode } = (await request.json()) as { mode: NetworkMode }
    box.network.inbound = { mode, allow_net: [] }
    return HttpResponse.json(box.network.inbound)
  }),
  // Refuses without inbound access, like the real route.
  http.post(`${API_URL}/v1/:prefix/boxes/:boxId/network/tunnel`, ({ params, request }) => {
    const boxId = String(params.boxId)
    const box = MOCK_BOXES.find((b) => b.id === boxId)
    if (box?.network?.inbound.mode !== NetworkMode.ENABLED) return new HttpResponse(null, { status: 409 })
    const port = new URL(request.url).searchParams.get('port')
    // Mirrors the real hex-encoded direct-preview host shape. Hand-rolled
    // rather than via Buffer, which does not exist in the browser.
    const encodedBoxId = [...boxId].map((char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    return HttpResponse.json({ uri: `https://${port}-d-${encodedBoxId}.proxy.mock.boxlite.ai` })
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

  // Image catalog and registry logins. Static registry routes are declared
  // before `/images/:idOrRef`, as the real API orders them. Deleting a catalog
  // image is soft and answers 409 while a box can still boot from it; curated
  // images cannot be deleted at all.
  // `localStorage['registries-unsupported'] = '1'` answers as a deploy with
  // no secret store does (registries.service.ts), for that state of the panel.
  http.get(`${API_URL}/images/registries`, () =>
    globalThis.localStorage?.getItem('registries-unsupported') === '1'
      ? HttpResponse.json(
          {
            statusCode: 501,
            message: 'Registry credentials are not configured for this deployment',
            code: 'unsupported',
          },
          { status: 501 },
        )
      : HttpResponse.json(MOCK_REGISTRY_CREDENTIALS),
  ),
  http.post(`${API_URL}/images/registries`, async ({ request }) => {
    const body = (await request.json()) as {
      registryHost: string
      repositoryPrefix?: string
      username: string
      password: string
    }
    const repositoryPrefix = body.repositoryPrefix ?? ''
    const taken = MOCK_REGISTRY_CREDENTIALS.some(
      (c) => c.registryHost === body.registryHost && c.repositoryPrefix === repositoryPrefix,
    )
    if (taken) {
      return HttpResponse.json(
        {
          statusCode: 409,
          message: `A credential for ${body.registryHost}/${repositoryPrefix} already exists; remove it before adding another`,
          error: 'Conflict',
        },
        { status: 409 },
      )
    }
    const created = {
      id: `reg-${Math.abs(Date.now() % 100000000)}`,
      kind: RegistryCredentialKind.BASIC,
      registryHost: body.registryHost,
      repositoryPrefix,
      username: body.username,
      createdBy: 'mock-user',
      createdAt: new Date().toISOString(),
    }
    MOCK_REGISTRY_CREDENTIALS.unshift(created)
    return HttpResponse.json(created, { status: 201 })
  }),
  http.delete(`${API_URL}/images/registries/:id`, ({ params }) => {
    const index = MOCK_REGISTRY_CREDENTIALS.findIndex((c) => c.id === params.id)
    if (index < 0) return new HttpResponse(null, { status: 404 })
    const holders = boxesPullingThrough(MOCK_REGISTRY_CREDENTIALS[index])
    if (holders.length > 0) {
      return HttpResponse.json(
        {
          statusCode: 409,
          message: `Registry credential ${params.id} cannot be removed while ${holders.length} box(es) pull through it: ${holders.map((b) => b.id).join(', ')}`,
          error: 'Conflict',
        },
        { status: 409 },
      )
    }
    MOCK_REGISTRY_CREDENTIALS.splice(index, 1)
    return new HttpResponse(null, { status: 204 })
  }),
  http.get(`${API_URL}/images/usage`, () => {
    const owned = MOCK_IMAGE_DETAILS.filter((i) => !i.curated)
    return HttpResponse.json({
      count: owned.length,
      limit: MOCK_IMAGE_LIMIT,
      knownBytes: owned.reduce((sum, i) => sum + (i.sizeBytes ?? 0), 0),
    })
  }),
  http.get(`${API_URL}/images`, () =>
    HttpResponse.json(
      MOCK_IMAGE_DETAILS.map((detail) => {
        const image: Partial<typeof detail> = { ...detail }
        delete image.versions
        delete image.history
        return image
      }),
    ),
  ),
  http.get(`${API_URL}/images/:idOrRef`, ({ params }) => {
    const key = decodeURIComponent(String(params.idOrRef))
    const image = MOCK_IMAGE_DETAILS.find((i) => i.id === key || i.name === key)
    return image ? HttpResponse.json(image) : new HttpResponse(null, { status: 404 })
  }),
  http.delete(`${API_URL}/images/:idOrRef`, ({ params }) => {
    const key = decodeURIComponent(String(params.idOrRef))
    const index = MOCK_IMAGE_DETAILS.findIndex((i) => i.id === key || i.name === key)
    if (index < 0) return new HttpResponse(null, { status: 404 })
    const image = MOCK_IMAGE_DETAILS[index]
    if (image.curated) {
      return HttpResponse.json(
        { statusCode: 403, message: 'Curated images belong to the operator', error: 'Forbidden' },
        { status: 403 },
      )
    }
    const holders = boxesReferencing(image.name)
    if (holders.length > 0) {
      return HttpResponse.json(
        {
          statusCode: 409,
          message: `Image '${image.name}' cannot be removed while ${holders.length} box(es) can still boot from it: ${holders.map((b) => b.id).join(', ')}`,
          error: 'Conflict',
        },
        { status: 409 },
      )
    }
    MOCK_IMAGE_DETAILS.splice(index, 1)
    return new HttpResponse(null, { status: 204 })
  }),
  // Pinning answers as the API does: OCI tag syntax, a READY version of this
  // image, and 409 for any existing name, the same version included.
  http.post(`${API_URL}/images/:idOrRef/aliases`, async ({ params, request }) => {
    const key = decodeURIComponent(String(params.idOrRef))
    const image = MOCK_IMAGE_DETAILS.find((i) => i.id === key || i.name === key)
    if (!image) return new HttpResponse(null, { status: 404 })
    const body = (await request.json()) as { alias: string; versionId: string }
    if (image.curated) {
      return HttpResponse.json(
        {
          statusCode: 400,
          message: `Image '${image.name}' is provided by the operator, so its aliases cannot be changed`,
        },
        { status: 400 },
      )
    }
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(body.alias)) {
      return HttpResponse.json(
        { statusCode: 400, message: `Image alias '${body.alias}' must use OCI tag syntax` },
        { status: 400 },
      )
    }
    const version = image.versions.find((v) => v.id === body.versionId)
    if (!version) {
      return HttpResponse.json(
        { statusCode: 400, message: `Version '${body.versionId}' is not a version of image '${image.name}'` },
        { status: 400 },
      )
    }
    if (image.aliases.includes(body.alias)) {
      return HttpResponse.json(
        {
          statusCode: 409,
          message: `Alias '${body.alias}' already exists for image '${image.name}'; delete it explicitly before creating it again`,
          code: 'already_exists',
        },
        { status: 409 },
      )
    }
    image.aliases.push(body.alias)
    version.aliases.push(body.alias)
    image.history.unshift({
      aliasName: body.alias,
      fromVersionId: null,
      fromDigest: null,
      toVersionId: version.id,
      toDigest: version.digest,
      actorId: MOCK_ORGANIZATION_MEMBER.userId,
      createdAt: new Date().toISOString(),
    })
    return new HttpResponse(null, { status: 201 })
  }),
  // Unpinning writes no history event, as the API does not.
  http.delete(`${API_URL}/images/:idOrRef/aliases/:alias`, ({ params }) => {
    const key = decodeURIComponent(String(params.idOrRef))
    const alias = decodeURIComponent(String(params.alias))
    const image = MOCK_IMAGE_DETAILS.find((i) => i.id === key || i.name === key)
    if (!image) return new HttpResponse(null, { status: 404 })
    if (!image.aliases.includes(alias)) {
      return HttpResponse.json(
        { statusCode: 404, message: `Alias '${alias}' not found for image '${image.name}'` },
        { status: 404 },
      )
    }
    image.aliases = image.aliases.filter((a) => a !== alias)
    for (const version of image.versions) version.aliases = version.aliases.filter((a) => a !== alias)
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
      usageChargeMultiplier: '1.0000',
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
        // A standing auto-reload rule bought these off-session — the charge the
        // customer did not initiate, and the one hardest to place on a card
        // statement. The wire carries no `source`, so it is deliberately
        // indistinguishable here from the manual purchase below; that is why
        // the label is "Credits" and not "Top-up".
        id: 'inv-013',
        number: 'BOX-2026-0012',
        sequentialId: 12,
        type: 'credit',
        chargedAt: new Date('2026-01-22').toISOString(),
        totalAmountCents: 5_000,
        totalPaidCents: 5_000,
        quotaCoveredCents: 0,
        paymentStatus: 'succeeded',
        voided: false,
      },
      {
        id: 'inv-010',
        number: 'BOX-2026-0011',
        sequentialId: 11,
        type: 'credit',
        chargedAt: new Date('2026-01-14').toISOString(),
        totalAmountCents: 10_000,
        totalPaidCents: 10_000,
        quotaCoveredCents: 0,
        paymentStatus: 'succeeded',
        voided: false,
      },
      {
        id: 'inv-011',
        number: 'BOX-2026-0010',
        sequentialId: 10,
        type: 'one_off',
        // The upgrade that granted 548.37 of quota cost this much to buy.
        chargedAt: new Date('2026-01-09').toISOString(),
        totalAmountCents: 4_231,
        totalPaidCents: 4_231,
        quotaCoveredCents: 0,
        paymentStatus: 'succeeded',
        voided: false,
      },
      {
        id: 'inv-012',
        number: 'BOX-2026-0009',
        sequentialId: 9,
        type: 'subscription',
        chargedAt: new Date('2026-01-05').toISOString(),
        totalAmountCents: 25_000,
        totalPaidCents: 0,
        quotaCoveredCents: 0,
        paymentStatus: 'pending',
        voided: false,
      },
      {
        id: 'inv-001',
        number: 'INV-2026-001',
        sequentialId: 1,
        type: 'advance_charges',
        chargedAt: new Date('2026-01-01').toISOString(),
        totalAmountCents: 9847,
        totalPaidCents: 1_847,
        quotaCoveredCents: 8_000,
        paymentStatus: 'succeeded',
        voided: false,
      },
      {
        id: 'inv-004',
        number: 'INV-2025-010',
        sequentialId: 10,
        type: 'advance_charges',
        chargedAt: new Date('2025-10-01').toISOString(),
        totalAmountCents: 12150,
        totalPaidCents: 0,
        quotaCoveredCents: 12_150,
        paymentStatus: 'succeeded',
        voided: false,
      },
      {
        id: 'inv-009',
        number: 'INV-2030-010',
        sequentialId: 10,
        type: 'advance_charges',
        chargedAt: new Date('2025-10-01').toISOString(),
        totalAmountCents: 12150,
        totalPaidCents: 2_150,
        quotaCoveredCents: 10_000,
        paymentStatus: 'succeeded',
        voided: true,
      },
      {
        id: 'inv-005',
        number: 'INV-2025-009',
        sequentialId: 9,
        type: 'advance_charges',
        chargedAt: new Date('2025-09-01').toISOString(),
        totalAmountCents: 8900,
        // Nothing reached the card, which is what the Amount column reports.
        totalPaidCents: 0,
        quotaCoveredCents: 0,
        paymentStatus: 'failed',
        voided: false,
      },
      // A year of ordinary months underneath, so the page fills and pages.
      ...buildInvoiceHistory(),
    ]

    // Mirror Commerce: no `type` means settlements only, `all` means every
    // kind, otherwise the named subset. Without this the mock cannot show the
    // difference the billing history exists to make visible.
    const requestedTypes = url.searchParams.get('type')
    const visibleInvoices = newestFirst(
      requestedTypes === 'all'
        ? mockInvoices
        : mockInvoices.filter((invoice) => (requestedTypes?.split(',') ?? ['advance_charges']).includes(invoice.type)),
    )

    const startIndex = (page - 1) * perPage
    const endIndex = startIndex + perPage
    const paginatedItems = visibleInvoices.slice(startIndex, endIndex)
    const totalItems = visibleInvoices.length
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
      // The same year of ordinary months as the invoice feed: the cycle grant
      // that funds the plan and the usage that draws it back down.
      ...buildWalletHistory(),
    ]
    const ledger = newestFirst(transactions)
    const start = (page - 1) * perPage

    return HttpResponse.json<PaginatedWalletTransactions>({
      items: ledger.slice(start, start + perPage),
      totalItems: ledger.length,
      totalPages: Math.ceil(ledger.length / perPage),
    })
  }),
  http.post(`${BILLING_API_URL}/organization/:organizationId/wallet/top-up`, async () => {
    return HttpResponse.json<PaymentUrl>({
      url: `https://checkout.stripe.com/pay/cs_test_${Date.now()}`,
    })
  }),
  http.get(`${BILLING_API_URL}/organization/:organizationId/coupon/register`, () =>
    HttpResponse.json<SignupCreditDelivery>({ delivered: signupCreditDelivered() }),
  ),
]
