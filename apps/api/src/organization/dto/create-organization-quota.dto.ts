/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import { IsNumber, IsOptional } from 'class-validator'

@ApiSchema({ name: 'CreateOrganizationQuota' })
export class CreateOrganizationQuotaDto {
  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  totalCpuQuota?: number

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  totalMemoryQuota?: number

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  totalDiskQuota?: number

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  maxCpuPerBox?: number

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  maxMemoryPerBox?: number

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  maxDiskPerBox?: number

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  snapshotQuota?: number

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  maxSnapshotSize?: number

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  volumeQuota?: number
}
