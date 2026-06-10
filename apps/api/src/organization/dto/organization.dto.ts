/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import { Organization } from '../entities/organization.entity'

@ApiSchema({ name: 'Organization' })
export class OrganizationDto {
  @ApiProperty({
    description: 'Organization ID',
  })
  id: string

  @ApiProperty({
    description: 'Organization name',
  })
  name: string

  @ApiProperty({
    description: 'User ID of the organization creator',
  })
  createdBy: string

  @ApiProperty({
    description: 'Whether this organization is the authenticated user default organization',
  })
  isDefaultForAuthenticatedUser: boolean

  @ApiProperty({
    description:
      'Deprecated alias for isDefaultForAuthenticatedUser. Kept for backward compatibility with older REST clients.',
    deprecated: true,
  })
  personal: boolean

  @ApiProperty({
    description: 'Creation timestamp',
  })
  createdAt: Date

  @ApiProperty({
    description: 'Last update timestamp',
  })
  updatedAt: Date

  @ApiProperty({
    description: 'Suspended flag',
  })
  suspended: boolean

  @ApiProperty({
    description: 'Suspended at',
  })
  suspendedAt?: Date

  @ApiProperty({
    description: 'Suspended reason',
  })
  suspensionReason?: string

  @ApiProperty({
    description: 'Suspended until',
  })
  suspendedUntil?: Date

  @ApiProperty({
    description: 'Suspension cleanup grace period hours',
  })
  suspensionCleanupGracePeriodHours?: number

  @ApiProperty({
    description: 'Max CPU per box',
  })
  maxCpuPerBox: number

  @ApiProperty({
    description: 'Max memory per box',
  })
  maxMemoryPerBox: number

  @ApiProperty({
    description: 'Max disk per box',
  })
  maxDiskPerBox: number

  @ApiProperty({
    description: 'Time in minutes before an unused template is deactivated',
    default: 20160,
  })
  templateDeactivationTimeoutMinutes: number

  @ApiProperty({
    description: 'Box default network block all',
  })
  boxLimitedNetworkEgress: boolean

  @ApiPropertyOptional({
    description: 'Default region ID',
    required: false,
  })
  defaultRegionId?: string

  @ApiProperty({
    description: 'Authenticated rate limit per minute',
    nullable: true,
  })
  authenticatedRateLimit: number | null

  @ApiProperty({
    description: 'Box create rate limit per minute',
    nullable: true,
  })
  boxCreateRateLimit: number | null

  @ApiProperty({
    description: 'Box lifecycle rate limit per minute',
    nullable: true,
  })
  boxLifecycleRateLimit: number | null

  @ApiProperty({
    description: 'Experimental configuration',
  })
  experimentalConfig: Record<string, any> | null

  @ApiProperty({
    description: 'Authenticated rate limit TTL in seconds',
    nullable: true,
  })
  authenticatedRateLimitTtlSeconds: number | null

  @ApiProperty({
    description: 'Box create rate limit TTL in seconds',
    nullable: true,
  })
  boxCreateRateLimitTtlSeconds: number | null

  @ApiProperty({
    description: 'Box lifecycle rate limit TTL in seconds',
    nullable: true,
  })
  boxLifecycleRateLimitTtlSeconds: number | null

  static fromOrganization(organization: Organization, isDefaultForAuthenticatedUser = false): OrganizationDto {
    const experimentalConfig = organization._experimentalConfig
    if (experimentalConfig && experimentalConfig.otel && experimentalConfig.otel.headers) {
      experimentalConfig.otel.headers = Object.entries(experimentalConfig.otel.headers).reduce(
        (acc, [key]) => {
          acc[key] = '******'
          return acc
        },
        {} as Record<string, string>,
      )
    }

    const dto: OrganizationDto = {
      id: organization.id,
      name: organization.name,
      createdBy: organization.createdBy,
      isDefaultForAuthenticatedUser,
      personal: isDefaultForAuthenticatedUser,
      createdAt: organization.createdAt,
      updatedAt: organization.updatedAt,
      suspended: organization.suspended,
      suspensionReason: organization.suspensionReason,
      suspendedAt: organization.suspendedAt,
      suspendedUntil: organization.suspendedUntil,
      suspensionCleanupGracePeriodHours: organization.suspensionCleanupGracePeriodHours,
      maxCpuPerBox: organization.maxCpuPerBox,
      maxMemoryPerBox: organization.maxMemoryPerBox,
      maxDiskPerBox: organization.maxDiskPerBox,
      templateDeactivationTimeoutMinutes: organization.templateDeactivationTimeoutMinutes,
      boxLimitedNetworkEgress: organization.boxLimitedNetworkEgress,
      defaultRegionId: organization.defaultRegionId,
      authenticatedRateLimit: organization.authenticatedRateLimit,
      boxCreateRateLimit: organization.boxCreateRateLimit,
      boxLifecycleRateLimit: organization.boxLifecycleRateLimit,
      experimentalConfig,
      authenticatedRateLimitTtlSeconds: organization.authenticatedRateLimitTtlSeconds,
      boxCreateRateLimitTtlSeconds: organization.boxCreateRateLimitTtlSeconds,
      boxLifecycleRateLimitTtlSeconds: organization.boxLifecycleRateLimitTtlSeconds,
    }

    return dto
  }
}
