/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty } from '@nestjs/swagger'
import { IsInt, IsNumber, IsNumberString, Min } from 'class-validator'

/**
 * Actual (cgroup-measured) usage the runner reports for a box's current period.
 * Drives over-commit / COGS only — never billing. RSS bytes are sent as strings
 * (they map to bigint columns).
 */
export class ReportBoxActualUsageDto {
  @ApiProperty({ description: 'CPU-seconds actually consumed (cgroup usage_usec delta)' })
  @IsNumber()
  @Min(0)
  actualCpuSeconds: number

  @ApiProperty({ description: 'Mean resident memory across samples, bytes (bigint as string)' })
  @IsNumberString()
  actualRssAvgBytes: string

  @ApiProperty({ description: 'Peak resident memory across samples, bytes (bigint as string)' })
  @IsNumberString()
  actualRssPeakBytes: string

  @ApiProperty({ description: 'Number of cgroup samples folded into this report' })
  @IsInt()
  @Min(0)
  sampleCount: number
}
