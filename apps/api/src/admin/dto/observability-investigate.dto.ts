/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import { LogEntryDto } from '../../box-telemetry/dto/log-entry.dto'
import { MetricsResponseDto } from '../../box-telemetry/dto/metrics-response.dto'
import { TraceSpanDto } from '../../box-telemetry/dto/trace-span.dto'
import { AdminBoxItemDto, AdminMachineItemDto, AdminRunnerItemDto } from './admin-overview.dto'
import { AdminObservabilityQueryParamsDto } from './observability-query.dto'

export const ADMIN_OBSERVABILITY_SOURCES = [
  'clickhouse',
  'clickstack',
  'postgres',
  'audit',
  'cloudwatch',
  's3',
  'xlog',
] as const
export type AdminObservabilitySource = (typeof ADMIN_OBSERVABILITY_SOURCES)[number]

export const ADMIN_OBSERVABILITY_SOURCE_STATES = ['available', 'missing', 'stale', 'not_configured', 'error'] as const
export type AdminObservabilitySourceState = (typeof ADMIN_OBSERVABILITY_SOURCE_STATES)[number]

@ApiSchema({ name: 'AdminObservabilityInvestigateQuery' })
export class AdminObservabilityInvestigateQueryParamsDto extends AdminObservabilityQueryParamsDto {}

@ApiSchema({ name: 'AdminObservabilityCorrelation' })
export class AdminObservabilityCorrelationDto {
  @ApiProperty({ type: [String] })
  traceIds: string[]

  @ApiProperty({ type: [String] })
  orgIds: string[]

  @ApiProperty({ type: [String] })
  userIds: string[]

  @ApiProperty({ type: [String] })
  boxIds: string[]

  @ApiProperty({ type: [String] })
  runnerIds: string[]

  @ApiProperty({ type: [String] })
  machineIds: string[]

  @ApiProperty({ type: [String] })
  requestIds: string[]

  @ApiProperty({ type: [String] })
  operationIds: string[]

  @ApiProperty({ type: [String] })
  executionIds: string[]

  @ApiProperty({ type: [String] })
  jobIds: string[]

  @ApiProperty({ type: [String] })
  serviceNames: string[]
}

@ApiSchema({ name: 'AdminObservabilitySourceStatus' })
export class AdminObservabilitySourceStatusDto {
  @ApiProperty({ enum: ADMIN_OBSERVABILITY_SOURCES })
  source: AdminObservabilitySource

  @ApiProperty({ enum: ADMIN_OBSERVABILITY_SOURCE_STATES })
  state: AdminObservabilitySourceState

  @ApiPropertyOptional()
  message?: string

  @ApiPropertyOptional()
  count?: number
}

@ApiSchema({ name: 'AdminObservabilityResourceSummary' })
export class AdminObservabilityResourceSummaryDto {
  @ApiProperty({
    enum: ['box', 'runner', 'machine', 'trace', 'request', 'operation', 'execution', 'job', 'org', 'user', 'unknown'],
  })
  type:
    | 'box'
    | 'runner'
    | 'machine'
    | 'trace'
    | 'request'
    | 'operation'
    | 'execution'
    | 'job'
    | 'org'
    | 'user'
    | 'unknown'

  @ApiProperty()
  title: string

  @ApiPropertyOptional()
  subtitle?: string

  @ApiPropertyOptional()
  state?: string

  @ApiPropertyOptional()
  owner?: string

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  identifiers?: Record<string, string>

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  timeRange?: { from?: string; to?: string }
}

@ApiSchema({ name: 'AdminObservabilityTimelineEvent' })
export class AdminObservabilityTimelineEventDto {
  @ApiProperty()
  timestamp: string

  @ApiProperty()
  source: string

  @ApiProperty()
  title: string

  @ApiPropertyOptional()
  detail?: string

  @ApiPropertyOptional()
  severity?: string

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  identifiers?: Record<string, string>
}

@ApiSchema({ name: 'AdminObservabilityOperation' })
export class AdminObservabilityOperationDto {
  @ApiProperty()
  id: string

  @ApiProperty()
  label: string

  @ApiProperty({
    enum: ['enabled', 'disabled', 'request_only'],
  })
  state: 'enabled' | 'disabled' | 'request_only'

  @ApiProperty()
  method: string

  @ApiProperty()
  path: string

  @ApiProperty()
  reason: string

  @ApiPropertyOptional()
  targetId?: string
}

@ApiSchema({ name: 'AdminObservabilityCommands' })
export class AdminObservabilityCommandsDto {
  @ApiProperty()
  api: string

  @ApiProperty()
  aiAgentPrompt: string
}

@ApiSchema({ name: 'AdminObservabilityClickStackSourceSetup' })
export class AdminObservabilityClickStackSourceSetupDto {
  @ApiProperty({ enum: ['logs', 'traces', 'metrics'] })
  kind: 'logs' | 'traces' | 'metrics'

  @ApiProperty()
  envVar: string

  @ApiProperty()
  name: string

  @ApiProperty()
  dataType: string

  @ApiProperty()
  database: string

  @ApiPropertyOptional()
  table?: string

  @ApiProperty()
  timestampColumn: string

  @ApiPropertyOptional()
  defaultSelect?: string

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  fields?: Record<string, string>

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  metricTables?: Record<string, string>
}

@ApiSchema({ name: 'AdminObservabilityClickStackLinks' })
export class AdminObservabilityClickStackLinksDto {
  @ApiProperty()
  configured: boolean

  @ApiPropertyOptional()
  message?: string

  @ApiPropertyOptional({ type: [String] })
  missingSources?: string[]

  @ApiPropertyOptional({ type: [AdminObservabilityClickStackSourceSetupDto] })
  sourceSetup?: AdminObservabilityClickStackSourceSetupDto[]

  @ApiPropertyOptional()
  logsUrl?: string

  @ApiPropertyOptional()
  dashboardUrl?: string

  @ApiPropertyOptional()
  tracesUrl?: string

  @ApiPropertyOptional()
  metricsUrl?: string

  @ApiPropertyOptional()
  query?: string

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  queryContext?: Record<string, unknown>
}

@ApiSchema({ name: 'AdminObservabilityExternalLinks' })
export class AdminObservabilityExternalLinksDto {
  @ApiProperty({ type: AdminObservabilityClickStackLinksDto })
  clickstack: AdminObservabilityClickStackLinksDto
}

@ApiSchema({ name: 'AdminObservabilityAuditLog' })
export class AdminObservabilityAuditLogDto {
  @ApiProperty()
  id: string

  @ApiProperty()
  actorId: string

  @ApiProperty()
  actorEmail: string

  @ApiPropertyOptional()
  organizationId?: string

  @ApiProperty()
  action: string

  @ApiPropertyOptional()
  targetType?: string

  @ApiPropertyOptional()
  targetId?: string

  @ApiPropertyOptional()
  statusCode?: number

  @ApiPropertyOptional()
  errorMessage?: string

  @ApiPropertyOptional()
  source?: string

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  metadata?: Record<string, unknown>

  @ApiProperty()
  createdAt: Date
}

@ApiSchema({ name: 'AdminObservabilityXLog' })
export class AdminObservabilityXLogDto {
  @ApiProperty()
  source: string

  @ApiProperty()
  timestamp: string

  @ApiProperty()
  serviceName: string

  @ApiProperty()
  body: string

  @ApiPropertyOptional()
  severityText?: string

  @ApiPropertyOptional()
  traceId?: string

  @ApiPropertyOptional()
  spanId?: string

  @ApiPropertyOptional()
  executionId?: string

  @ApiPropertyOptional()
  jobId?: string

  @ApiPropertyOptional()
  stream?: string

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  attributes?: Record<string, unknown>
}

@ApiSchema({ name: 'AdminObservabilityS3Object' })
export class AdminObservabilityS3ObjectDto {
  @ApiProperty()
  bucket: string

  @ApiProperty()
  key: string

  @ApiPropertyOptional()
  size?: number

  @ApiPropertyOptional()
  lastModified?: Date

  @ApiPropertyOptional()
  etag?: string

  @ApiPropertyOptional()
  matchedBy?: string
}

@ApiSchema({ name: 'AdminObservabilityInvestigateResponse' })
export class AdminObservabilityInvestigateResponseDto {
  @ApiProperty({ type: AdminObservabilityResourceSummaryDto })
  resource: AdminObservabilityResourceSummaryDto

  @ApiProperty({ type: AdminObservabilityCorrelationDto })
  correlation: AdminObservabilityCorrelationDto

  @ApiProperty({ type: [AdminObservabilitySourceStatusDto] })
  sources: AdminObservabilitySourceStatusDto[]

  @ApiProperty({ type: [TraceSpanDto] })
  traceSpans: TraceSpanDto[]

  @ApiProperty({ type: [LogEntryDto] })
  logs: LogEntryDto[]

  @ApiProperty({ type: MetricsResponseDto })
  metrics: MetricsResponseDto

  @ApiProperty({ type: [AdminBoxItemDto] })
  boxes: AdminBoxItemDto[]

  @ApiProperty({ type: [AdminRunnerItemDto] })
  runners: AdminRunnerItemDto[]

  @ApiProperty({ type: [AdminMachineItemDto] })
  machines: AdminMachineItemDto[]

  @ApiProperty({ type: [AdminObservabilityAuditLogDto] })
  auditLogs: AdminObservabilityAuditLogDto[]

  @ApiProperty({ type: [AdminObservabilityXLogDto] })
  xlogs: AdminObservabilityXLogDto[]

  @ApiProperty({ type: [AdminObservabilityS3ObjectDto] })
  s3Objects: AdminObservabilityS3ObjectDto[]

  @ApiProperty({ type: [AdminObservabilityTimelineEventDto] })
  timeline: AdminObservabilityTimelineEventDto[]

  @ApiProperty({ type: [AdminObservabilityOperationDto] })
  operations: AdminObservabilityOperationDto[]

  @ApiProperty({ type: AdminObservabilityCommandsDto })
  commands: AdminObservabilityCommandsDto

  @ApiProperty({ type: AdminObservabilityExternalLinksDto })
  externalLinks: AdminObservabilityExternalLinksDto
}
