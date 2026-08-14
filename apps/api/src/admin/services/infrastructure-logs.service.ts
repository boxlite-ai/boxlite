/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  BadRequestException,
  GatewayTimeoutException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common'
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs'
import { TypedConfigService } from '../../config/typed-config.service'
import {
  InfrastructureLogSource,
  InfrastructureLogsDto,
  InfrastructureLogsQueryDto,
} from '../dto/infrastructure-logs.dto'

const MAX_QUERY_RANGE_MS = 24 * 60 * 60 * 1000
const QUERY_TIMEOUT_MS = 8_000
export const INFRASTRUCTURE_LOGS_CLIENT = Symbol('INFRASTRUCTURE_LOGS_CLIENT')

@Injectable()
export class InfrastructureLogsService {
  private readonly client: Pick<CloudWatchLogsClient, 'send'>

  constructor(
    private readonly config: TypedConfigService,
    @Optional()
    @Inject(INFRASTRUCTURE_LOGS_CLIENT)
    client?: Pick<CloudWatchLogsClient, 'send'>,
  ) {
    this.client = client ?? new CloudWatchLogsClient({ region: this.config.get('infrastructureLogs.region') })
  }

  async query(query: InfrastructureLogsQueryDto): Promise<InfrastructureLogsDto> {
    const source = query.source ?? InfrastructureLogSource.RUNNER
    const logGroupName = this.logGroupFor(source)
    if (!logGroupName) {
      throw new ServiceUnavailableException('Infrastructure log search is not configured')
    }

    const startTime = Date.parse(query.from)
    const endTime = Date.parse(query.to)
    if (startTime > endTime) {
      throw new BadRequestException('from must be before to')
    }
    if (endTime - startTime > MAX_QUERY_RANGE_MS) {
      throw new BadRequestException('Infrastructure log searches are limited to 24 hours')
    }

    const abortController = new AbortController()
    const timeout = setTimeout(() => abortController.abort(), QUERY_TIMEOUT_MS)
    let response
    try {
      response = await this.client.send(
        new FilterLogEventsCommand({
          logGroupName,
          startTime,
          endTime,
          limit: query.limit,
          nextToken: query.nextToken,
          filterPattern: query.search?.trim() ? quoteFilterTerm(query.search.trim()) : undefined,
        }),
        { abortSignal: abortController.signal },
      )
    } catch (error) {
      if (abortController.signal.aborted) {
        throw new GatewayTimeoutException('Infrastructure log search timed out')
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }

    return {
      items: (response.events ?? []).map((event) => ({
        timestamp: new Date(event.timestamp ?? 0).toISOString(),
        body: event.message ?? '',
        severityText: inferSeverity(event.message),
        serviceName: source === InfrastructureLogSource.COLLECTOR ? 'otel-collector' : 'runner-infrastructure',
        resourceAttributes: {
          'aws.log_group': logGroupName,
          'aws.log_stream': event.logStreamName ?? '',
        },
        logAttributes: {
          ...(event.eventId ? { 'aws.event_id': event.eventId } : {}),
          ...(event.ingestionTime ? { 'aws.ingestion_time': new Date(event.ingestionTime).toISOString() } : {}),
        },
      })),
      nextToken: response.nextToken,
    }
  }

  private logGroupFor(source: InfrastructureLogSource): string | undefined {
    if (source === InfrastructureLogSource.COLLECTOR) {
      return this.config.get('infrastructureLogs.collectorLogGroupName')
    }
    return (
      this.config.get('infrastructureLogs.runnerLogGroupName') || this.config.get('infrastructureLogs.logGroupName')
    )
  }
}

function quoteFilterTerm(term: string): string {
  if ([...term].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) {
    throw new BadRequestException('search must not contain control characters')
  }
  return `"${term.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function inferSeverity(message?: string): string {
  const severity = message?.match(/\b(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL)\b/i)?.[1]?.toUpperCase()
  return severity === 'WARNING' ? 'WARN' : severity || 'INFO'
}
