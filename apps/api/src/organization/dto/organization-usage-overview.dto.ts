/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiSchema } from '@nestjs/swagger'

/**
 * What an organization currently consumes against each of its ceilings.
 *
 * Flat rather than upstream's `regionUsage: RegionUsageOverview[]`: BoxLite quotas
 * are a single org-wide row and usage is summed across every region, so there is
 * no region or box-class dimension to break down by.
 *
 * `current*` figures include outstanding pending reservations, so a box that is
 * mid-create already counts — the same number the quota check enforces against.
 */
@ApiSchema({ name: 'OrganizationUsageOverview' })
export class OrganizationUsageOverviewDto {
  @ApiProperty({ description: 'vCPU currently consumed by running boxes', example: 12 })
  currentCpuUsage: number

  @ApiProperty({ description: 'Total vCPU the organization may consume', example: 64 })
  totalCpuQuota: number

  @ApiProperty({ description: 'Memory in GB currently consumed by running boxes', example: 48 })
  currentMemoryUsage: number

  @ApiProperty({ description: 'Total memory in GB the organization may consume', example: 256 })
  totalMemoryQuota: number

  @ApiProperty({ description: 'Disk in GB currently occupied by boxes', example: 300 })
  currentDiskUsage: number

  @ApiProperty({ description: 'Total disk in GB the organization may occupy', example: 512 })
  totalDiskQuota: number

  @ApiProperty({ description: 'GPUs currently consumed by running boxes', example: 0 })
  currentGpuUsage: number

  @ApiProperty({ description: 'Total GPUs the organization may consume; 0 denies GPU boxes', example: 0 })
  totalGpuQuota: number

  @ApiProperty({ description: 'Boxes currently running', example: 3 })
  currentBoxUsage: number

  @ApiProperty({ description: 'Maximum number of concurrently running boxes', example: 50 })
  maxConcurrentBoxes: number

  @ApiProperty({ description: 'Volumes currently occupying storage', example: 4 })
  currentVolumeUsage: number

  @ApiProperty({ description: 'Maximum number of volumes that may occupy storage', example: 100 })
  maxVolumes: number
}
