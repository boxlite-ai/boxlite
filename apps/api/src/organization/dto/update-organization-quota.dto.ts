/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiSchema } from '@nestjs/swagger'

@ApiSchema({ name: 'UpdateOrganizationQuota' })
export class UpdateOrganizationQuotaDto {
  @ApiProperty({ nullable: true })
  maxCpuPerBox?: number

  @ApiProperty({ nullable: true })
  maxMemoryPerBox?: number

  @ApiProperty({ nullable: true })
  maxDiskPerBox?: number

  @ApiProperty({ nullable: true })
  snapshotQuota?: number

  @ApiProperty({ nullable: true })
  maxSnapshotSize?: number

  @ApiProperty({ nullable: true })
  volumeQuota?: number

  @ApiProperty({ nullable: true })
  authenticatedRateLimit?: number

  @ApiProperty({ nullable: true })
  boxCreateRateLimit?: number

  @ApiProperty({ nullable: true })
  boxLifecycleRateLimit?: number

  @ApiProperty({ nullable: true })
  authenticatedRateLimitTtlSeconds?: number

  @ApiProperty({ nullable: true })
  boxCreateRateLimitTtlSeconds?: number

  @ApiProperty({ nullable: true })
  boxLifecycleRateLimitTtlSeconds?: number

  @ApiProperty({ nullable: true, description: 'Time in minutes before an unused snapshot is deactivated' })
  snapshotDeactivationTimeoutMinutes?: number
}
