/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { AuditLogsQueryParams } from './useAuditLogsQuery'

export const queryKeys = {
  config: {
    all: ['config'] as const,
  },
  apiKeys: {
    all: ['api-keys'] as const,
    list: (organizationId: string) => [...queryKeys.apiKeys.all, organizationId, 'list'] as const,
  },
  webhooks: {
    all: ['webhooks'] as const,
    appPortalAccess: (organizationId: string) =>
      [...queryKeys.webhooks.all, organizationId, 'app-portal-access'] as const,
    initializationStatus: (organizationId: string) =>
      [...queryKeys.webhooks.all, organizationId, 'initialization-status'] as const,
  },
  organization: {
    all: ['organization'] as const,

    list: () => [...queryKeys.organization.all, 'list'] as const,
    detail: (organizationId: string) => [...queryKeys.organization.all, organizationId, 'detail'] as const,

    usage: {
      overview: (organizationId: string) =>
        [...queryKeys.organization.all, organizationId, 'usage', 'overview'] as const,
      current: (organizationId: string) => [...queryKeys.organization.all, organizationId, 'usage', 'current'] as const,
      past: (organizationId: string) => [...queryKeys.organization.all, organizationId, 'usage', 'past'] as const,
    },

    tier: (organizationId: string) => [...queryKeys.organization.all, organizationId, 'tier'] as const,
    wallet: (organizationId: string) => [...queryKeys.organization.all, organizationId, 'wallet'] as const,
  },
  user: {
    all: ['users'] as const,
    accountProviders: () => [...queryKeys.user.all, 'account-providers'] as const,
  },
  billing: {
    all: ['billing'] as const,
    tiers: () => [...queryKeys.billing.all, 'tiers'] as const,
    emails: (organizationId: string) => [...queryKeys.billing.all, organizationId, 'emails'] as const,
    portalUrl: (organizationId: string) => [...queryKeys.billing.all, organizationId, 'portal-url'] as const,
    checkoutUrl: (organizationId: string) => [...queryKeys.billing.all, organizationId, 'checkout-url'] as const,
    invoices: (organizationId: string, page?: number, perPage?: number) =>
      [
        ...queryKeys.billing.all,
        organizationId,
        'invoices',
        ...(page !== undefined && perPage !== undefined ? [{ page, perPage }] : []),
      ] as const,
  },
  // TODO(image-rewrite): template query keys removed with the image/template subsystem.
  registries: {
    all: ['registries'] as const,
    list: (organizationId: string) => [...queryKeys.registries.all, organizationId, 'list'] as const,
  },
  volumes: {
    all: ['volumes'] as const,
    list: (organizationId: string) => [...queryKeys.volumes.all, organizationId, 'list'] as const,
  },
  audit: {
    all: ['audit'] as const,
    logs: (organizationId: string, params: AuditLogsQueryParams) =>
      [
        ...queryKeys.audit.all,
        organizationId,
        'logs',
        {
          page: params.page,
          pageSize: params.pageSize,
          ...(params.from && { from: params.from.toISOString() }),
          ...(params.to && { to: params.to.toISOString() }),
          ...(params.cursor && { cursor: params.cursor }),
        },
      ] as const,
  },
  boxes: {
    all: ['boxes'] as const,
    detail: (organizationId: string, boxId: string) =>
      [...queryKeys.boxes.all, organizationId, boxId, 'detail'] as const,
    terminalSession: (boxId: string) => [...queryKeys.boxes.all, boxId, 'terminal-session'] as const,
    vncInitialStatus: (boxId: string) => [...queryKeys.boxes.all, boxId, 'vnc-initial-status'] as const,
    vncPollStatus: (boxId: string) => [...queryKeys.boxes.all, boxId, 'vnc-poll-status'] as const,
    vncSession: (boxId: string) => [...queryKeys.boxes.all, boxId, 'vnc-session'] as const,
  },
  telemetry: {
    all: ['telemetry'] as const,
    logs: (boxId: string, params: object) => [...queryKeys.telemetry.all, boxId, 'logs', params] as const,
    traces: (boxId: string, params: object) => [...queryKeys.telemetry.all, boxId, 'traces', params] as const,
    metrics: (boxId: string, params: object) => [...queryKeys.telemetry.all, boxId, 'metrics', params] as const,
    traceSpans: (boxId: string, traceId: string) => [...queryKeys.telemetry.all, boxId, 'traces', traceId] as const,
  },
  box: {
    all: ['box'] as const,
    session: (scope: string) => [...queryKeys.box.all, scope] as const,
    currentId: (scope: string) => [...queryKeys.box.all, scope, 'current-id'] as const,
    instance: (scope: string, id: string) => [...queryKeys.box.all, scope, id] as const,
    terminalUrl: (scope: string, id: string) => [...queryKeys.box.all, scope, id, 'terminal-url'] as const,
    vncStatus: (scope: string, id: string) => [...queryKeys.box.all, scope, id, 'vnc-status'] as const,
    vncUrl: (scope: string, id: string) => [...queryKeys.box.all, scope, id, 'vnc-url'] as const,
  },
  analytics: {
    all: ['analytics'] as const,
    aggregatedUsage: (organizationId: string, params: object) =>
      [...queryKeys.analytics.all, organizationId, 'aggregated-usage', params] as const,
    usageChart: (organizationId: string, params: object) =>
      [...queryKeys.analytics.all, organizationId, 'usage-chart', params] as const,
    boxesUsage: (organizationId: string, params: object) =>
      [...queryKeys.analytics.all, organizationId, 'boxes-usage', params] as const,
    boxUsagePeriods: (organizationId: string, boxId: string, params: object) =>
      [...queryKeys.analytics.all, organizationId, boxId, 'usage-periods', params] as const,
  },
} as const
