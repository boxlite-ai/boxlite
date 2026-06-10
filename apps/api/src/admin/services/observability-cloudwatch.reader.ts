/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { CloudWatchLogsClient, DescribeLogGroupsCommand, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs'
import { TypedConfigService } from '../../config/typed-config.service'
import { LogEntryDto } from '../../box-telemetry/dto/log-entry.dto'
import {
  AdminObservabilityCorrelationDto,
  AdminObservabilityInvestigateQueryParamsDto,
  AdminObservabilitySourceStatusDto,
} from '../dto/observability-investigate.dto'

interface CloudWatchFilterResponse {
  events?: Array<{
    eventId?: string
    ingestionTime?: number
    logStreamName?: string
    message?: string
    timestamp?: number
  }>
}

@Injectable()
export class AdminCloudWatchLogReader {
  private readonly clients = new Map<string, CloudWatchLogsClient>()

  constructor(private readonly configService: TypedConfigService) {}

  async getRelatedLogs(
    query: AdminObservabilityInvestigateQueryParamsDto,
    correlation: AdminObservabilityCorrelationDto,
  ): Promise<{ logs: LogEntryDto[]; status: AdminObservabilitySourceStatusDto }> {
    const logGroups = this.configService.get('adminObservability.cloudwatch.logGroups')
    const logGroupPrefix = this.configService.get('adminObservability.cloudwatch.logGroupPrefix')
    const maxLogGroups = this.configService.get('adminObservability.cloudwatch.maxLogGroups') || 20
    const region = this.configService.get('adminObservability.cloudwatch.region')
    const limitPerGroup = this.configService.get('adminObservability.cloudwatch.limitPerGroup') || 25

    if (!region || (logGroups.length === 0 && !logGroupPrefix)) {
      return {
        logs: [],
        status: {
          source: 'cloudwatch',
          state: 'not_configured',
          message:
            'ADMIN_OBSERVABILITY_CLOUDWATCH_LOG_GROUPS or ADMIN_OBSERVABILITY_CLOUDWATCH_LOG_GROUP_PREFIX is not configured',
          count: 0,
        },
      }
    }

    const terms = this.buildSearchTerms(query, correlation)
    if (terms.length === 0) {
      return {
        logs: [],
        status: {
          source: 'cloudwatch',
          state: 'available',
          message: 'CloudWatch is configured, but no correlation identifiers were available for fallback search',
          count: 0,
        },
      }
    }

    const { from, to } = this.buildTimeRange(query)
    const events = new Map<string, LogEntryDto>()
    const resolvedLogGroups =
      logGroups.length > 0 || !logGroupPrefix
        ? logGroups
        : await this.describeLogGroups(region, logGroupPrefix, maxLogGroups)

    if (resolvedLogGroups.length === 0) {
      return {
        logs: [],
        status: {
          source: 'cloudwatch',
          state: 'available',
          message: 'CloudWatch is configured, but no log groups matched the configured prefix',
          count: 0,
        },
      }
    }

    for (const logGroupName of resolvedLogGroups) {
      for (const term of terms.slice(0, 6)) {
        const response = await this.filterLogEvents(region, {
          logGroupName,
          filterPattern: this.quoteFilterTerm(term),
          startTime: from.getTime(),
          endTime: to.getTime(),
          limit: Math.max(1, Math.min(limitPerGroup, 100)),
        })

        for (const event of response.events ?? []) {
          const key = `${logGroupName}:${event.logStreamName ?? ''}:${event.timestamp ?? ''}:${event.eventId ?? ''}`
          if (!events.has(key)) {
            events.set(key, this.toLogEntry(logGroupName, term, event))
          }
        }
      }
    }

    const logs = Array.from(events.values()).sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    return {
      logs,
      status: {
        source: 'cloudwatch',
        state: 'available',
        count: logs.length,
        ...(logs.length === 0 ? { message: 'No CloudWatch stdout entries matched the current correlation' } : {}),
      },
    }
  }

  private async filterLogEvents(
    region: string,
    body: {
      logGroupName: string
      filterPattern: string
      startTime: number
      endTime: number
      limit: number
    },
  ): Promise<CloudWatchFilterResponse> {
    return this.client(region).send(new FilterLogEventsCommand(body))
  }

  private async describeLogGroups(region: string, prefix: string, maxLogGroups: number): Promise<string[]> {
    const response = await this.client(region).send(
      new DescribeLogGroupsCommand({
        logGroupNamePrefix: prefix,
        limit: Math.max(1, Math.min(maxLogGroups, 50)),
      }),
    )
    return (response.logGroups ?? [])
      .map((group) => group.logGroupName)
      .filter((name): name is string => Boolean(name))
      .slice(0, maxLogGroups)
  }

  private client(region: string): CloudWatchLogsClient {
    let client = this.clients.get(region)
    if (!client) {
      client = new CloudWatchLogsClient({ region })
      this.clients.set(region, client)
    }
    return client
  }

  private toLogEntry(
    logGroupName: string,
    matchedBy: string,
    event: NonNullable<CloudWatchFilterResponse['events']>[number],
  ): LogEntryDto {
    const parsed = this.tryParseMessage(event.message ?? '')
    const body = parsed.body ?? event.message ?? ''
    const resourceAttributes = {
      'boxlite.source': 'cloudwatch',
      'boxlite.layer': this.inferLayer(logGroupName),
      'aws.log_group': logGroupName,
      'aws.log_stream': event.logStreamName ?? '',
    }
    const logAttributes = {
      'cloudwatch.event_id': event.eventId ?? '',
      'cloudwatch.ingestion_time': event.ingestionTime ? new Date(event.ingestionTime).toISOString() : '',
      'cloudwatch.matched_by': matchedBy,
      ...parsed.attributes,
    }

    return {
      timestamp: event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString(),
      body,
      severityText: parsed.severityText ?? this.inferSeverity(body),
      serviceName: parsed.serviceName ?? `cloudwatch:${logGroupName.split('/').filter(Boolean).pop() ?? 'stdout'}`,
      resourceAttributes,
      logAttributes,
      traceId: parsed.traceId ?? this.extractTraceId(body),
      spanId: parsed.spanId,
    }
  }

  private tryParseMessage(message: string): {
    body?: string
    severityText?: string
    serviceName?: string
    traceId?: string
    spanId?: string
    attributes: Record<string, string>
  } {
    try {
      const payload = JSON.parse(message) as Record<string, unknown>
      const attributes: Record<string, string> = {}
      for (const [key, value] of Object.entries(payload)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          attributes[key] = String(value)
        }
      }
      return {
        body: this.readString(payload, ['msg', 'message', 'body']),
        severityText: this.normalizeSeverity(this.readString(payload, ['level', 'severity', 'severityText'])),
        serviceName: this.readString(payload, ['serviceName', 'service_name']),
        traceId: this.readString(payload, ['traceId', 'trace_id']),
        spanId: this.readString(payload, ['spanId', 'span_id']),
        attributes,
      }
    } catch {
      return { attributes: {} }
    }
  }

  private readString(payload: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = payload[key]
      if (typeof value === 'string' && value.trim()) {
        return value.trim()
      }
      if (typeof value === 'number') {
        return String(value)
      }
    }
    return undefined
  }

  private inferLayer(logGroupName: string): string {
    if (logGroupName.includes('/Api')) return 'api'
    if (logGroupName.includes('/SshGateway') || logGroupName.includes('/Proxy')) return 'runner'
    if (logGroupName.includes('/OtelCollector')) return 'ec2_host'
    return ''
  }

  private inferSeverity(message: string): string {
    const normalized = message.toLowerCase()
    if (normalized.includes('error') || normalized.includes('exception')) return 'ERROR'
    if (normalized.includes('warn')) return 'WARN'
    if (normalized.includes('debug')) return 'DEBUG'
    return 'INFO'
  }

  private normalizeSeverity(value?: string): string | undefined {
    if (!value) return undefined
    const normalized = value.toUpperCase()
    if (normalized === '10') return 'TRACE'
    if (normalized === '20') return 'DEBUG'
    if (normalized === '30') return 'INFO'
    if (normalized === '40') return 'WARN'
    if (normalized === '50') return 'ERROR'
    if (normalized === '60') return 'FATAL'
    return normalized
  }

  private extractTraceId(message: string): string | undefined {
    return message.match(/\b[0-9a-f]{32}\b/i)?.[0]
  }

  private buildSearchTerms(
    query: AdminObservabilityInvestigateQueryParamsDto,
    correlation: AdminObservabilityCorrelationDto,
  ): string[] {
    return Array.from(
      new Set(
        [
          query.traceId,
          query.requestId,
          query.operationId,
          query.executionId,
          query.jobId,
          query.boxId,
          query.runnerId,
          query.machineId,
          query.serviceName,
          ...correlation.traceIds,
          ...correlation.requestIds,
          ...correlation.operationIds,
          ...correlation.executionIds,
          ...correlation.jobIds,
          ...correlation.boxIds,
          ...correlation.runnerIds,
          ...correlation.machineIds,
          ...correlation.serviceNames,
        ].filter((value): value is string => typeof value === 'string' && value.trim().length >= 3),
      ),
    )
  }

  private quoteFilterTerm(term: string): string {
    return `"${term.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }

  private buildTimeRange(query: AdminObservabilityInvestigateQueryParamsDto): { from: Date; to: Date } {
    const to = query.to ? new Date(query.to) : new Date()
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 60 * 60 * 1000)
    return { from, to }
  }
}
