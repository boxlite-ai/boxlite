/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

// Self-contained fixtures for the MSW mock target (`npm run start:mock`).
// They let the dashboard render its core surfaces (shell, organizations,
// boxes) with no backend and no login, so local UI work doesn't depend on a
// reachable dev API. Shapes follow the generated API client types.

import type { Invoice } from '@/billing-api/types/Invoice'
import type { WalletTransaction } from '@/billing-api/types/WalletTransaction'
import { catalogNameOf } from '@/lib/image-ref'
import {
  type Box,
  BoxClassEnum,
  BoxDesiredState,
  BoxProgressPhase,
  BoxState,
  ImageDetail,
  RegistryCredential,
  RegistryCredentialKind,
  type BoxliteConfiguration,
  NetworkMode,
  type Organization,
  type OrganizationUser,
  OrganizationUserRoleEnum,
  type PaginatedBoxes,
  type VolumeDto,
  VolumeState,
} from '@boxlite-ai/api-client'

export const MOCK_USER = {
  sub: 'mock-user-00000000',
  name: 'Mock User',
  email: 'mock@boxlite.dev',
  picture: undefined as string | undefined,
}

export const MOCK_ORGANIZATION_ID = 'mock-org-00000000'

const nowDate = new Date()
const epochDate = new Date(0)
const now = nowDate.toISOString()

// Declared before the boxes so a box can be given a realistic age. A volume's
// `lastUsedAt` is derived from its holders' `createdAt` (see MOCK_VOLUMES), so
// the two sets of timestamps have to be expressible in the same terms.
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

export function buildMockConfig(billingApiUrl: string): BoxliteConfiguration {
  return {
    version: '0.0.0-mock',
    // OIDC values are placeholders: the mock target swaps the real AuthProvider
    // for a fake authenticated session, so no OIDC network call is ever made.
    //
    // The issuer is production's, though, because it is what `resolveEnvironment`
    // reads. Mock exists to show the console as users see it, and a placeholder
    // here made the quickstart advertise a different endpoint locally than in
    // production — which reads as "the change did not take" rather than "this
    // screen resolves its URL somewhere else".
    oidc: {
      issuer: 'https://auth.boxlite.ai/',
      clientId: 'mock-client',
      audience: 'https://mock.local/api',
    },
    linkedAccountsEnabled: false,
    announcements: {},
    proxyTemplateUrl: 'https://mock.local',
    proxyToolboxUrl: 'https://mock.local',
    dashboardUrl: 'http://localhost:3000',
    maintananceMode: false,
    environment: 'mock',
    billingApiUrl,
  }
}

export const MOCK_ORGANIZATION: Organization = {
  id: MOCK_ORGANIZATION_ID,
  name: 'Mock Org',
  createdBy: MOCK_USER.sub,
  isDefaultForAuthenticatedUser: true,
  personal: true,
  createdAt: nowDate,
  updatedAt: nowDate,
  suspended: false,
  suspendedAt: epochDate,
  suspensionReason: '',
  suspendedUntil: epochDate,
  suspensionCleanupGracePeriodHours: 0,
  maxCpuPerBox: 8,
  maxMemoryPerBox: 16,
  maxDiskPerBox: 100,
  boxLimitedNetworkEgress: false,
  authenticatedRateLimit: null,
  boxCreateRateLimit: null,
  boxLifecycleRateLimit: null,
  experimentalConfig: {},
  authenticatedRateLimitTtlSeconds: null,
  boxCreateRateLimitTtlSeconds: null,
  boxLifecycleRateLimitTtlSeconds: null,
}

// Owner role short-circuits permission checks, so every action is enabled.
export const MOCK_ORGANIZATION_MEMBER: OrganizationUser = {
  userId: MOCK_USER.sub,
  organizationId: MOCK_ORGANIZATION_ID,
  name: MOCK_USER.name,
  email: MOCK_USER.email,
  role: OrganizationUserRoleEnum.OWNER,
  isDefaultForUser: true,
  assignedRoles: [],
  createdAt: nowDate,
  updatedAt: nowDate,
}

export function buildBox(overrides: Partial<Box> & Pick<Box, 'id' | 'name' | 'state'>): Box {
  return {
    organizationId: MOCK_ORGANIZATION_ID,
    user: MOCK_USER.email,
    env: {},
    labels: {},
    network: {
      outbound: { mode: NetworkMode.ENABLED, allow_net: [] },
      inbound: { mode: NetworkMode.DISABLED, allow_net: [] },
    },
    target: 'mock',
    image: 'ghcr.io/boxlite-ai/boxlite-agent-base:mock',
    cpu: 1,
    gpu: 0,
    memory: 1,
    disk: 10,
    desiredState: BoxDesiredState.STARTED,
    createdAt: now,
    updatedAt: now,
    class: BoxClassEnum.SMALL,
    toolboxProxyUrl: 'https://mock.local',
    ...overrides,
  }
}

export const MOCK_BOXES: Box[] = [
  buildBox({
    id: 'mock-box-running',
    name: 'web-api',
    state: BoxState.STARTED,
    createdAt: hoursAgo(2),
    volumes: [
      { volumeId: 'subtitle-models', mountPath: '/models' },
      { volumeId: 'customer-data', mountPath: '/data', subpath: 'acme' },
    ],
  } as Partial<Box> & Pick<Box, 'id' | 'name' | 'state'>),
  buildBox({
    id: 'mock-box-stopped',
    name: 'batch-worker',
    state: BoxState.STOPPED,
    createdAt: daysAgo(5),
    desiredState: BoxDesiredState.STOPPED,
    image: 'ghcr.io/boxlite-ai/boxlite-agent-python:mock',
    cpu: 2,
    memory: 4,
    disk: 20,
  }),
  buildBox({
    id: 'mock-box-error',
    name: 'flaky-job',
    state: BoxState.ERROR,
    errorReason: 'Mock failure for UI testing',
    recoverable: true,
    image: 'ghcr.io/boxlite-ai/boxlite-agent-node:mock',
  }),
  // Boxes on a tenant image. Both block its removal: any box not destroyed
  // does, stopped included (image-catalog.service.ts).
  buildBox({
    id: 'mock-box-agent-1',
    name: 'agile-otter',
    state: BoxState.STARTED,
    createdAt: hoursAgo(1),
    image: 'ghcr.io/acme/agent-runtime:v1.4.2',
  }),
  buildBox({
    id: 'mock-box-agent-2',
    name: 'quiet-heron',
    state: BoxState.STOPPED,
    desiredState: BoxDesiredState.STOPPED,
    createdAt: daysAgo(2),
    image: 'ghcr.io/acme/agent-runtime:v1.4.2',
  }),
  // A first pull in progress: the API reports it as `progress` while CREATING.
  buildBox({
    id: 'mock-box-pulling',
    name: 'eager-lynx',
    state: BoxState.CREATING,
    createdAt: now,
    image: 'docker.io/library/golang:1.23-alpine',
    progress: { phase: BoxProgressPhase.PREPARING_IMAGE, retryAfterMs: 5000 },
  }),
  // A private pull refused: the API's own wording (image-pull-failure.service.ts).
  buildBox({
    id: 'mock-box-private',
    name: 'shy-badger',
    state: BoxState.ERROR,
    createdAt: hoursAgo(3),
    image: 'quay.io/acme/internal-tools:2.1',
    errorReason:
      "Failed to pull image 'quay.io/acme/internal-tools:2.1': quay.io refused the pull (UNAUTHORIZED). The image is private or does not exist, and no registry login of the organization covers it.",
  }),
]

export const MOCK_PAGINATED_BOXES: PaginatedBoxes = {
  items: MOCK_BOXES,
  total: MOCK_BOXES.length,
  page: 1,
  totalPages: 1,
}

// ── Volumes ─────────────────────────────────────────────────────────────────
// Covers the states the page has to render differently: a healthy mounted
// volume, one nobody has mounted for a month (the cleanup candidate the list
// exists to surface), a soft-deleted one still sitting in `pending_delete`
// because removal is asynchronous, one still coming up, and a failed one.
function buildVolume(overrides: Partial<VolumeDto> & Pick<VolumeDto, 'id' | 'name' | 'state'>): VolumeDto {
  return {
    organizationId: MOCK_ORGANIZATION_ID,
    createdAt: daysAgo(31),
    updatedAt: now,
    lastUsedAt: undefined,
    ...overrides,
  } as VolumeDto
}

export const MOCK_VOLUMES: VolumeDto[] = [
  // `lastUsedAt` is not free-form: the API sets it to the `createdAt` of the
  // most recently created box that mounts the volume (volume.service.ts,
  // BoxEvents.CREATED). So each value below is the newest holder's age in
  // MOCK_VOLUME_USAGE — otherwise the page renders a state the real system
  // cannot produce (a live holder alongside an older "latest mount").
  buildVolume({
    id: 'vol-a1b2c3d4',
    name: 'subtitle-models',
    state: VolumeState.READY,
    createdAt: daysAgo(31),
    // held by web-api (2h) and batch-worker (5d) — newest wins
    lastUsedAt: hoursAgo(2),
  }),
  buildVolume({
    id: 'vol-e5f6g7h8',
    name: 'customer-data',
    state: VolumeState.READY,
    createdAt: daysAgo(12),
    // held by web-api only
    lastUsedAt: hoursAgo(2),
  }),
  buildVolume({
    id: 'vol-i9j0k1l2',
    name: 'scratch-0812',
    state: VolumeState.READY,
    createdAt: daysAgo(31),
    lastUsedAt: daysAgo(31),
  }),
  buildVolume({
    id: 'vol-m3n4o5p6',
    name: 'tmp-debug',
    state: VolumeState.PENDING_DELETE,
    createdAt: daysAgo(9),
    lastUsedAt: daysAgo(5),
  }),
  buildVolume({
    id: 'vol-q7r8s9t0',
    name: 'render-cache',
    state: VolumeState.CREATING,
    createdAt: now,
  }),
  buildVolume({
    id: 'vol-u1v2w3x4',
    name: 'broken-vol',
    state: VolumeState.ERROR,
    createdAt: daysAgo(3),
    errorReason: 'Backing bucket unreachable',
  }),
]

// Which boxes currently mount which volume.
//
// The API cannot answer this yet: the reverse lookup exists in the backend but
// only inside the delete guard, as a `.getOne()` (volume.service.ts:92-104).
// The page is designed against the shape it *will* have once that is exposed
// (see PRD §7), and the mock stands in for it meanwhile.
export const MOCK_VOLUME_USAGE: Record<string, { boxId: string; boxName: string; mountPath: string }[]> = {
  'vol-a1b2c3d4': [
    { boxId: 'mock-box-running', boxName: 'web-api', mountPath: '/models' },
    { boxId: 'mock-box-stopped', boxName: 'batch-worker', mountPath: '/models' },
  ],
  'vol-e5f6g7h8': [{ boxId: 'mock-box-running', boxName: 'web-api', mountPath: '/data' }],
}

// --- Billing history depth -------------------------------------------------
//
// The hand-written invoice and wallet rows in handlers.ts are a *coverage*
// fixture: one of every type, status and label variant, so nothing renders as
// `undefined`. They are deliberately few, which means the billing page in mock
// never fills, never paginates, and never shows what a year of documents looks
// like. These generators supply the *depth* the curated rows sit on top of.
//
// Everything below is arithmetic, no RNG: the same reload gives the same
// history, so a screenshot is reproducible and a change in the UI is a real one.

/** The mock "today". Every generated date is counted back from here. */
const HISTORY_END = new Date('2026-01-22T00:00:00.000Z')

const DAY_MS = 86_400_000

/**
 * Calculates a date string counting back from the mock "today".
 *
 * @param days - Number of days to count back from HISTORY_END
 * @returns ISO 8601 date string
 */
function daysBefore(days: number): string {
  return new Date(HISTORY_END.getTime() - days * DAY_MS).toISOString()
}

/**
 * Usage settles every third day and the plan renews monthly, so a year reaches
 * ~150 documents — past the page size the billing history requests, which is
 * the only way the pager is reachable in mock at all.
 */
export function buildInvoiceHistory(): Invoice[] {
  const rows: Invoice[] = []

  for (let day = 3; day <= 365; day += 3) {
    // A sawtooth between roughly $6 and $46, so the amount column has shape
    // instead of one repeated number. Quota absorbs the first $20 of each.
    const amountCents = 640 + ((day * 37) % 4_000)
    rows.push({
      id: `inv-usage-${day}`,
      number: `BOX-2025-${String(2_000 - day).padStart(4, '0')}`,
      sequentialId: 2_000 - day,
      type: 'advance_charges',
      chargedAt: daysBefore(day),
      totalAmountCents: amountCents,
      totalPaidCents: Math.max(0, amountCents - 2_000),
      quotaCoveredCents: Math.min(amountCents, 2_000),
      paymentStatus: 'succeeded',
      voided: false,
    })
  }

  for (let month = 1; month <= 12; month += 1) {
    rows.push({
      id: `inv-renewal-${month}`,
      number: `BOX-2025-${String(2_100 + month).padStart(4, '0')}`,
      sequentialId: 2_100 + month,
      type: 'subscription',
      chargedAt: daysBefore(month * 30),
      totalAmountCents: 25_000,
      totalPaidCents: 25_000,
      quotaCoveredCents: 0,
      paymentStatus: 'succeeded',
      voided: false,
    })
  }

  // Roughly every six weeks the balance ran low and credits were bought. Some
  // of these were a person clicking Top up and some were a standing auto-reload
  // rule firing off-session; the invoice wire carries no `source`, so they are
  // indistinguishable here on purpose — which is why the label is "Credits".
  for (let index = 1; index <= 8; index += 1) {
    rows.push({
      id: `inv-credit-${index}`,
      number: `BOX-2025-${String(2_200 + index).padStart(4, '0')}`,
      sequentialId: 2_200 + index,
      type: 'credit',
      chargedAt: daysBefore(index * 42),
      totalAmountCents: index % 2 === 0 ? 5_000 : 10_000,
      totalPaidCents: index % 2 === 0 ? 5_000 : 10_000,
      quotaCoveredCents: 0,
      paymentStatus: 'succeeded',
      voided: false,
    })
  }

  return rows
}

/**
 * The credit ledger over the same span: the monthly cycle grant that funds the
 * plan, and the usage that draws it back down.
 */
export function buildWalletHistory(): WalletTransaction[] {
  const rows: WalletTransaction[] = []

  for (let month = 1; month <= 12; month += 1) {
    const createdAt = daysBefore(month * 30)
    rows.push({
      id: `txn-cycle-${month}`,
      direction: 'inbound',
      kind: 'granted',
      status: 'settled',
      source: 'interval',
      amountCents: 25_000,
      name: 'Pro monthly quota',
      subscriptionCreditKind: 'cycle',
      createdAt,
      settledAt: createdAt,
    })
  }

  for (let day = 3; day <= 365; day += 3) {
    const createdAt = daysBefore(day)
    rows.push({
      id: `txn-usage-${day}`,
      direction: 'outbound',
      kind: 'invoiced',
      status: 'settled',
      source: 'interval',
      amountCents: 640 + ((day * 37) % 4_000),
      name: null,
      subscriptionCreditKind: null,
      createdAt,
      settledAt: createdAt,
    })
  }

  return rows
}

/** Newest first — the order both feeds are served in. */
export function newestFirst<T extends Invoice | WalletTransaction>(rows: T[]): T[] {
  const chargedOrCreated = (row: T) => ('chargedAt' in row ? row.chargedAt : row.createdAt)
  return [...rows].sort((left, right) => chargedOrCreated(right).localeCompare(chargedOrCreated(left)))
}

// Image catalog. Curated rows belong to the operator: no id, no versions, no
// size, never deletable. Tenant rows are seeded by successful pulls; one is
// still held by a box (delete answers 409), one has gone missing upstream.
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const HOUR = 3_600_000
const DAY = 24 * HOUR
const curated = (name: string) => ({
  name,
  id: null,
  curated: true,
  curatedRef: `ghcr.io/boxlite-ai/${name}:latest`,
  aliases: [] as string[],
  versionCount: 0,
  sizeBytes: null,
  lastUsedAt: null,
  createdAt: null,
})
const MIB = 1024 * 1024
const PY_V1 = 'sha256:3f1c9a0d6b7e2a4c8f5d1e0b9a7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c'
const PY_V2 = 'sha256:8a2b4c6d8e0f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b'
const NODE_V1 = 'sha256:c0ffee00d15ea5e0ba5eba11deadbeefcafef00d0123456789abcdef01234567'
const AGENT_V1 = 'sha256:5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed'

export const MOCK_IMAGE_DETAILS: ImageDetail[] = [
  { ...curated('base'), versions: [], history: [] },
  { ...curated('python'), versions: [], history: [] },
  { ...curated('node'), versions: [], history: [] },
  {
    name: 'docker.io/library/python',
    id: 'img-python',
    curated: false,
    curatedRef: null,
    aliases: ['3.14-slim-bookworm', '3.13-slim'],
    versionCount: 2,
    sizeBytes: 45 * MIB + 41 * MIB,
    lastUsedAt: ago(2 * DAY),
    createdAt: ago(9 * DAY),
    versions: [
      {
        id: 'ver-py-2',
        digest: PY_V2,
        sizeBytes: 45 * MIB,
        sourceRef: 'docker.io/library/python:3.14-slim-bookworm',
        aliases: ['3.14-slim-bookworm'],
        lastUsedAt: ago(2 * DAY),
        upstreamMissingAt: null,
        createdAt: ago(3 * DAY),
      },
      {
        id: 'ver-py-1',
        digest: PY_V1,
        sizeBytes: 41 * MIB,
        sourceRef: 'docker.io/library/python:3.13-slim',
        aliases: ['3.13-slim'],
        lastUsedAt: ago(8 * DAY),
        upstreamMissingAt: null,
        createdAt: ago(9 * DAY),
      },
    ],
    history: [
      {
        aliasName: '3.14-slim-bookworm',
        fromVersionId: null,
        fromDigest: null,
        toVersionId: 'ver-py-2',
        toDigest: PY_V2,
        actorId: null,
        createdAt: ago(3 * DAY),
      },
      {
        aliasName: '3.13-slim',
        fromVersionId: null,
        fromDigest: null,
        toVersionId: 'ver-py-1',
        toDigest: PY_V1,
        actorId: null,
        createdAt: ago(9 * DAY),
      },
    ],
  },
  {
    name: 'ghcr.io/acme/agent-runtime',
    id: 'img-agent',
    curated: false,
    curatedRef: null,
    aliases: ['v1.4.2'],
    versionCount: 1,
    sizeBytes: 312 * MIB,
    lastUsedAt: ago(20 * 60_000),
    createdAt: ago(5 * DAY),
    versions: [
      {
        id: 'ver-agent-1',
        digest: AGENT_V1,
        sizeBytes: 312 * MIB,
        sourceRef: 'ghcr.io/acme/agent-runtime:v1.4.2',
        aliases: ['v1.4.2'],
        lastUsedAt: ago(20 * 60_000),
        upstreamMissingAt: null,
        createdAt: ago(5 * DAY),
      },
    ],
    history: [],
  },
  {
    name: 'docker.io/library/node',
    id: 'img-node',
    curated: false,
    curatedRef: null,
    aliases: ['22-alpine'],
    versionCount: 1,
    sizeBytes: 58 * MIB,
    lastUsedAt: ago(6 * DAY),
    createdAt: ago(12 * DAY),
    versions: [
      {
        id: 'ver-node-1',
        digest: NODE_V1,
        sizeBytes: 58 * MIB,
        sourceRef: 'docker.io/library/node:22-alpine',
        aliases: ['22-alpine'],
        lastUsedAt: ago(6 * DAY),
        upstreamMissingAt: ago(HOUR * 5),
        createdAt: ago(12 * DAY),
      },
    ],
    history: [
      {
        aliasName: '22-alpine',
        fromVersionId: null,
        fromDigest: null,
        toVersionId: 'ver-node-1',
        toDigest: NODE_V1,
        actorId: null,
        createdAt: ago(12 * DAY),
      },
    ],
  },
]

export const MOCK_IMAGE_LIMIT = 20

export const MOCK_REGISTRY_CREDENTIALS: RegistryCredential[] = [
  {
    id: 'reg-ghcr-acme',
    kind: RegistryCredentialKind.BASIC,
    registryHost: 'ghcr.io',
    repositoryPrefix: 'acme/',
    username: 'acme-bot',
    createdBy: 'mock-user',
    createdAt: ago(5 * DAY),
  },
]

/**
 * What the API's registrar does when a box reaches STARTED: a tenant image
 * enters the catalog under its normalised name, its first tag pinned; a
 * known image gets its last start moved. Built-in images record nothing.
 */
export function registerImageFromBox(image: string) {
  const name = catalogNameOf(image)
  const builtIn = MOCK_IMAGE_DETAILS.find((i) => i.curated && (i.name === image || i.curatedRef === image))
  if (builtIn) return
  const existing = MOCK_IMAGE_DETAILS.find((i) => i.name === name)
  const startedAt = new Date().toISOString()
  if (existing) {
    existing.lastUsedAt = startedAt
    return
  }
  const tag = image.includes('@') ? null : (image.split('/').at(-1)?.split(':')[1] ?? 'latest')
  const digest = `sha256:${Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')}`
  const versionId = `ver-${Math.abs(Date.now() % 100000000)}`
  const sizeBytes = (40 + Math.floor(Math.random() * 200)) * MIB
  MOCK_IMAGE_DETAILS.push({
    name,
    id: `img-${Math.abs(Date.now() % 100000000)}`,
    curated: false,
    curatedRef: null,
    aliases: tag ? [tag] : [],
    versionCount: 1,
    sizeBytes,
    lastUsedAt: startedAt,
    createdAt: startedAt,
    versions: [
      {
        id: versionId,
        digest,
        sizeBytes,
        sourceRef: image,
        aliases: tag ? [tag] : [],
        lastUsedAt: startedAt,
        upstreamMissingAt: null,
        createdAt: startedAt,
      },
    ],
    history: tag
      ? [
          {
            aliasName: tag,
            fromVersionId: null,
            fromDigest: null,
            toVersionId: versionId,
            toDigest: digest,
            actorId: null,
            createdAt: startedAt,
          },
        ]
      : [],
  })
}
