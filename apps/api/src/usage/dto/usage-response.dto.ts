/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'

@ApiSchema({ name: 'UsagePeriod' })
export class UsagePeriodDto {
  @ApiProperty()
  cpu!: number

  @ApiProperty()
  diskGB!: number

  @ApiProperty({ type: String, format: 'date-time' })
  endAt!: string

  @ApiProperty()
  gpu!: number

  @ApiProperty({
    description: 'Always 0 for the self-hosted raw ledger. Monetary rating belongs to the external billing service.',
  })
  price!: number

  @ApiProperty()
  ramGB!: number

  @ApiProperty({ type: String, format: 'date-time' })
  startAt!: string
}

@ApiSchema({ name: 'AggregatedUsage' })
export class AggregatedUsageDto {
  @ApiProperty()
  boxCount!: number

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  firstStart?: string

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  lastEnd?: string

  @ApiProperty()
  totalCPUSeconds!: number

  @ApiProperty()
  totalDiskGBSeconds!: number

  @ApiProperty()
  totalGPUSeconds!: number

  @ApiProperty({
    description: 'Always 0 for the self-hosted raw ledger. Monetary rating belongs to the external billing service.',
  })
  totalPrice!: number

  @ApiProperty()
  totalRAMGBSeconds!: number
}

@ApiSchema({ name: 'BoxUsage' })
export class BoxUsageDto {
  @ApiProperty()
  boxId!: string

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  firstStart?: string

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  lastEnd?: string

  @ApiProperty()
  totalCPUSeconds!: number

  @ApiProperty()
  totalDiskGBSeconds!: number

  @ApiProperty()
  totalGPUSeconds!: number

  @ApiProperty({
    description: 'Always 0 for the self-hosted raw ledger. Monetary rating belongs to the external billing service.',
  })
  totalPrice!: number

  @ApiProperty()
  totalRAMGBSeconds!: number
}

@ApiSchema({ name: 'UsageChartPoint' })
export class UsageChartPointDto {
  @ApiProperty({
    description: 'Average allocated CPUs in this UTC-day bucket',
  })
  cpu!: number

  @ApiProperty({
    description: 'Always 0 for the self-hosted raw ledger. Monetary rating belongs to the external billing service.',
  })
  cpuPrice!: number

  @ApiProperty({
    description: 'Average allocated disk GB in this UTC-day bucket',
  })
  diskGB!: number

  @ApiProperty({
    description: 'Always 0 for the self-hosted raw ledger. Monetary rating belongs to the external billing service.',
  })
  diskPrice!: number

  @ApiProperty({
    description: 'Average allocated RAM GB in this UTC-day bucket',
  })
  ramGB!: number

  @ApiProperty({
    description: 'Always 0 for the self-hosted raw ledger. Monetary rating belongs to the external billing service.',
  })
  ramPrice!: number

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Start of the UTC-day bucket, clipped to the requested range',
  })
  time!: string
}
