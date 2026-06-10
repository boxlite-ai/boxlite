/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { TypedConfigService } from '../../config/typed-config.service'
import {
  AdminObservabilityCorrelationDto,
  AdminObservabilityS3ObjectDto,
  AdminObservabilitySourceStatusDto,
} from '../dto/observability-investigate.dto'

@Injectable()
export class AdminS3ObjectReader {
  constructor(private readonly configService: TypedConfigService) {}

  async listRelatedObjects(
    correlation: AdminObservabilityCorrelationDto,
  ): Promise<{ objects: AdminObservabilityS3ObjectDto[]; status: AdminObservabilitySourceStatusDto }> {
    const buckets = this.configService.get('adminObservability.s3.buckets')
    const region = this.configService.get('adminObservability.s3.region')
    const endpoint = this.configService.get('adminObservability.s3.endpoint')
    const accessKey = this.configService.get('adminObservability.s3.accessKey')
    const secretKey = this.configService.get('adminObservability.s3.secretKey')
    const maxObjects = this.configService.get('adminObservability.s3.maxObjects') || 25

    if (!region || buckets.length === 0) {
      return {
        objects: [],
        status: {
          source: 's3',
          state: 'not_configured',
          message: 'Admin S3 lookup requires region and at least one bucket',
          count: 0,
        },
      }
    }

    if ((accessKey && !secretKey) || (!accessKey && secretKey)) {
      return {
        objects: [],
        status: {
          source: 's3',
          state: 'not_configured',
          message: 'Admin S3 lookup static credentials require both access key and secret key',
          count: 0,
        },
      }
    }

    const prefixes = this.buildPrefixes(correlation)
    if (prefixes.length === 0) {
      return {
        objects: [],
        status: {
          source: 's3',
          state: 'available',
          message: 'S3 lookup is configured, but no correlation identifiers were available for prefix search',
          count: 0,
        },
      }
    }

    const clientConfig = {
      region,
      ...(endpoint
        ? { endpoint: endpoint.startsWith('http') ? endpoint : `http://${endpoint}`, forcePathStyle: true }
        : {}),
      ...(accessKey && secretKey ? { credentials: { accessKeyId: accessKey, secretAccessKey: secretKey } } : {}),
    }
    const client = new S3Client(clientConfig)
    const objects = new Map<string, AdminObservabilityS3ObjectDto>()

    for (const bucket of buckets) {
      for (const { prefix, matchedBy } of prefixes.slice(0, 12)) {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            MaxKeys: Math.max(1, Math.min(maxObjects, 100)),
          }),
        )
        for (const object of response.Contents ?? []) {
          if (!object.Key) {
            continue
          }
          const key = `${bucket}:${object.Key}`
          objects.set(key, {
            bucket,
            key: object.Key,
            size: object.Size,
            lastModified: object.LastModified,
            etag: object.ETag,
            matchedBy,
          })
        }
      }
    }

    const values = Array.from(objects.values()).slice(0, maxObjects)
    return {
      objects: values,
      status: {
        source: 's3',
        state: 'available',
        count: values.length,
        ...(values.length === 0 ? { message: 'No S3 objects matched the current correlation prefixes' } : {}),
      },
    }
  }

  private buildPrefixes(correlation: AdminObservabilityCorrelationDto): Array<{ prefix: string; matchedBy: string }> {
    const configured = this.configService
      .get('adminObservability.s3.prefixes')
      .map((prefix) => ({ prefix: this.normalizePrefix(prefix), matchedBy: 'configured-prefix' }))
    const correlated = [
      ...correlation.orgIds.map((id) => ({ prefix: `${id}/`, matchedBy: `org:${id}` })),
      ...correlation.boxIds.map((id) => ({ prefix: `${id}/`, matchedBy: `box:${id}` })),
      ...correlation.executionIds.map((id) => ({ prefix: `${id}/`, matchedBy: `execution:${id}` })),
      ...correlation.jobIds.map((id) => ({ prefix: `${id}/`, matchedBy: `job:${id}` })),
      ...correlation.traceIds.map((id) => ({ prefix: `${id}/`, matchedBy: `trace:${id}` })),
    ]
    const seen = new Set<string>()
    return [...correlated, ...configured].filter((candidate) => {
      if (!candidate.prefix || seen.has(candidate.prefix)) {
        return false
      }
      seen.add(candidate.prefix)
      return true
    })
  }

  private normalizePrefix(prefix: string): string {
    return prefix.startsWith('/') ? prefix.slice(1) : prefix
  }
}
