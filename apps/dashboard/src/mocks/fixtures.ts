/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

// Self-contained fixtures for the MSW mock target (`npm run start:mock`).
// They let the dashboard render its core surfaces (shell, organizations,
// boxes) with no backend and no login, so local UI work doesn't depend on a
// reachable dev API. Shapes follow the generated API client types.

import {
  type Box,
  BoxClassEnum,
  BoxDesiredState,
  BoxState,
  type BoxliteConfiguration,
  type Organization,
  type OrganizationUser,
  OrganizationUserRoleEnum,
  type PaginatedBoxes,
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

export function buildMockConfig(billingApiUrl: string): BoxliteConfiguration {
  return {
    version: '0.0.0-mock',
    // OIDC values are placeholders: the mock target swaps the real AuthProvider
    // for a fake authenticated session, so no OIDC network call is ever made.
    oidc: {
      issuer: 'https://mock.local/',
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
  templateDeactivationTimeoutMinutes: 0,
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

function buildBox(overrides: Partial<Box> & Pick<Box, 'id' | 'name' | 'state'>): Box {
  return {
    organizationId: MOCK_ORGANIZATION_ID,
    user: MOCK_USER.email,
    env: {},
    labels: {},
    public: false,
    networkBlockAll: false,
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
  buildBox({ id: 'mock-box-running', name: 'web-api', state: BoxState.STARTED }),
  buildBox({
    id: 'mock-box-stopped',
    name: 'batch-worker',
    state: BoxState.STOPPED,
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
]

export const MOCK_PAGINATED_BOXES: PaginatedBoxes = {
  items: MOCK_BOXES,
  total: MOCK_BOXES.length,
  page: 1,
  totalPages: 1,
}
