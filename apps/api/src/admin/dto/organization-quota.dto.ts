/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import { IsInt, IsOptional, Min } from 'class-validator'
import { OrgQuotaLimits } from '../../organization/services/org-quota'

@ApiSchema({ name: 'AdminOrganizationQuota' })
export class AdminOrganizationQuotaDto implements OrgQuotaLimits {
  @ApiProperty({ description: 'Total vCPU an organization may have running at once', example: 64 })
  totalCpuQuota: number

  @ApiProperty({ description: 'Total memory in GB an organization may have running at once', example: 256 })
  totalMemoryQuota: number

  @ApiProperty({ description: 'Total disk in GB an organization may occupy', example: 512 })
  totalDiskQuota: number

  @ApiProperty({ description: 'Total GPUs an organization may have running at once; 0 denies GPU boxes', example: 0 })
  totalGpuQuota: number

  @ApiProperty({ description: 'Maximum number of concurrently running boxes', example: 50 })
  maxConcurrentBoxes: number

  @ApiProperty({
    description: 'False when the organization has no quota row and is running on the built-in defaults',
    example: true,
  })
  customized: boolean
}

/**
 * Every field optional: a PATCH carries only the ceilings being changed. Omitted
 * fields keep their current value — or, for an organization still on the built-in
 * defaults, take the default.
 */
@ApiSchema({ name: 'AdminUpdateOrganizationQuota' })
export class AdminUpdateOrganizationQuotaDto {
  @ApiPropertyOptional({ description: 'Total vCPU an organization may have running at once', example: 64 })
  @IsInt()
  @Min(0)
  @IsOptional()
  totalCpuQuota?: number

  @ApiPropertyOptional({ description: 'Total memory in GB an organization may have running at once', example: 256 })
  @IsInt()
  @Min(0)
  @IsOptional()
  totalMemoryQuota?: number

  @ApiPropertyOptional({ description: 'Total disk in GB an organization may occupy', example: 512 })
  @IsInt()
  @Min(0)
  @IsOptional()
  totalDiskQuota?: number

  @ApiPropertyOptional({ description: 'Total GPUs an organization may have running at once', example: 0 })
  @IsInt()
  @Min(0)
  @IsOptional()
  totalGpuQuota?: number

  @ApiPropertyOptional({ description: 'Maximum number of concurrently running boxes', example: 50 })
  @IsInt()
  @Min(0)
  @IsOptional()
  maxConcurrentBoxes?: number
}
