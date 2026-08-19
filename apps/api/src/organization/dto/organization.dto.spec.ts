/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OrganizationDto } from './organization.dto'

describe('OrganizationDto', () => {
  it('publishes the cleanup deadline calculated from core lifecycle state', () => {
    const suspendedAt = new Date('2026-08-19T00:00:00.000Z')
    const organization = {
      id: 'org-1',
      name: 'Acme',
      createdBy: 'user-1',
      createdAt: suspendedAt,
      updatedAt: suspendedAt,
      suspended: true,
      suspendedAt,
      suspensionReason: 'Credits depleted',
      suspensionCleanupGracePeriodHours: 24,
      maxCpuPerBox: 8,
      maxMemoryPerBox: 16,
      maxDiskPerBox: 100,
      templateDeactivationTimeoutMinutes: 0,
      boxLimitedNetworkEgress: false,
      authenticatedRateLimit: null,
      boxCreateRateLimit: null,
      boxLifecycleRateLimit: null,
      _experimentalConfig: null,
      authenticatedRateLimitTtlSeconds: null,
      boxCreateRateLimitTtlSeconds: null,
      boxLifecycleRateLimitTtlSeconds: null,
    } as any

    expect(OrganizationDto.fromOrganization(organization).suspensionCleanupAt).toEqual(
      new Date('2026-08-20T00:00:00.000Z'),
    )
  })
})
