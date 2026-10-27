import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import {
  USAGE_DIMENSIONS,
  USAGE_GRANULARITIES,
  USAGE_METRICS,
  UsageDimension,
  UsageGranularity,
  UsageMetric,
} from '../utils/usage-query'

@ApiSchema({ name: 'AdminUsageQuery' })
export class AdminUsageQueryDto {
  @ApiProperty({ format: 'date-time' })
  from: string

  @ApiProperty({ format: 'date-time' })
  to: string

  @ApiProperty({ enum: USAGE_GRANULARITIES })
  granularity: UsageGranularity

  @ApiProperty({ enum: USAGE_METRICS, isArray: true })
  metrics: UsageMetric[]

  @ApiProperty({ enum: USAGE_DIMENSIONS, isArray: true, minItems: 1, maxItems: 2 })
  groupBy: UsageDimension[]

  @ApiPropertyOptional({ format: 'uuid' })
  organizationId?: string

  @ApiPropertyOptional({ maxLength: 128 })
  regionId?: string

  @ApiPropertyOptional({ maxLength: 128 })
  boxId?: string
}

@ApiSchema({ name: 'AdminUsageDimensions' })
class AdminUsageDimensionsDto {
  @ApiPropertyOptional()
  organizationId?: string

  @ApiPropertyOptional()
  regionId?: string

  @ApiPropertyOptional()
  boxId?: string
}

@ApiSchema({ name: 'AdminUsageValues' })
class AdminUsageValuesDto {
  @ApiPropertyOptional({ type: String, description: 'Recorded allocated vCPU-seconds as an exact decimal string.' })
  computeVcpuSeconds?: string

  @ApiPropertyOptional({ type: String, description: 'Recorded allocated byte-seconds as an exact decimal string.' })
  storageByteSeconds?: string

  @ApiPropertyOptional({ type: String, description: 'Recorded allocated GiB-seconds as an exact decimal string.' })
  memoryGibSeconds?: string
}

@ApiSchema({ name: 'AdminUsageItem' })
export class AdminUsageItemDto {
  @ApiProperty({ format: 'date-time' })
  from: string

  @ApiProperty({ format: 'date-time' })
  to: string

  @ApiProperty({ type: AdminUsageDimensionsDto })
  dimensions: AdminUsageDimensionsDto

  @ApiProperty({ type: AdminUsageValuesDto })
  values: AdminUsageValuesDto

  @ApiProperty({ type: 'integer', minimum: 1, maximum: 200000 })
  sourcePeriodCount: number
}

@ApiSchema({ name: 'AdminUsageCoverage' })
class AdminUsageCoverageDto {
  @ApiProperty({ enum: ['unknown'] })
  status: 'unknown'

  @ApiProperty({ enum: ['usage_events_not_backfilled'] })
  reason: 'usage_events_not_backfilled'
}

@ApiSchema({ name: 'AdminUsagePage' })
export class AdminUsagePageDto {
  @ApiProperty({ format: 'uuid' })
  queryId: string

  @ApiProperty({ format: 'date-time' })
  generatedAt: string

  @ApiProperty({ format: 'date-time' })
  expiresAt: string

  @ApiProperty({ enum: ['resource-usage-v1'] })
  definitionVersion: 'resource-usage-v1'

  @ApiProperty({ type: AdminUsageQueryDto })
  query: AdminUsageQueryDto

  @ApiProperty({ type: AdminUsageCoverageDto })
  coverage: AdminUsageCoverageDto

  @ApiProperty({ type: [AdminUsageItemDto] })
  items: AdminUsageItemDto[]

  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null
}

@ApiSchema({ name: 'AdminUsageError' })
export class AdminUsageErrorDto {
  @ApiProperty({ type: 'integer', enum: [400, 410, 422, 503] })
  statusCode: number

  @ApiProperty({
    enum: ['invalid_usage_query', 'usage_query_expired', 'usage_query_too_large', 'usage_source_unavailable'],
  })
  code: string

  @ApiProperty()
  message: string
}
