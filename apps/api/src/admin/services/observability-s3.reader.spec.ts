/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { AdminObservabilityCorrelationDto } from '../dto/observability-investigate.dto'
import { AdminS3ObjectReader } from './observability-s3.reader'

const mockSend = jest.fn()

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  ListObjectsV2Command: jest.fn().mockImplementation((input) => ({ input })),
}))

describe('AdminS3ObjectReader', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  function buildReader(values: Record<string, unknown>) {
    const configService = {
      get: jest.fn((key: string) => values[key]),
    }
    return {
      configService,
      reader: new AdminS3ObjectReader(configService as any),
    }
  }

  function buildCorrelation(
    overrides: Partial<AdminObservabilityCorrelationDto> = {},
  ): AdminObservabilityCorrelationDto {
    return {
      traceIds: [],
      orgIds: [],
      userIds: [],
      boxIds: [],
      runnerIds: [],
      machineIds: [],
      requestIds: [],
      operationIds: [],
      executionIds: [],
      jobIds: [],
      serviceNames: [],
      ...overrides,
    }
  }

  it('allows AWS task role credentials when region and buckets are configured', async () => {
    mockSend.mockResolvedValue({
      Contents: [
        {
          Key: 'box-1/xlog/output.txt',
          Size: 42,
          LastModified: new Date('2026-06-07T00:00:00.000Z'),
          ETag: '"etag-1"',
        },
      ],
    })
    const { reader } = buildReader({
      'adminObservability.s3.buckets': ['boxlite-dev-storage'],
      'adminObservability.s3.region': 'ap-southeast-1',
      'adminObservability.s3.endpoint': undefined,
      'adminObservability.s3.accessKey': undefined,
      'adminObservability.s3.secretKey': undefined,
      'adminObservability.s3.maxObjects': 25,
      'adminObservability.s3.prefixes': [],
    })

    const result = await reader.listRelatedObjects(buildCorrelation({ boxIds: ['box-1'] }))

    expect(S3Client).toHaveBeenCalledWith({ region: 'ap-southeast-1' })
    expect(ListObjectsV2Command).toHaveBeenCalledWith({
      Bucket: 'boxlite-dev-storage',
      Prefix: 'box-1/',
      MaxKeys: 25,
    })
    expect(result.status).toMatchObject({ source: 's3', state: 'available', count: 1 })
    expect(result.objects).toEqual([
      {
        bucket: 'boxlite-dev-storage',
        key: 'box-1/xlog/output.txt',
        size: 42,
        lastModified: new Date('2026-06-07T00:00:00.000Z'),
        etag: '"etag-1"',
        matchedBy: 'box:box-1',
      },
    ])
  })

  it('still supports explicit credentials for S3-compatible endpoints', async () => {
    mockSend.mockResolvedValue({ Contents: [] })
    const { reader } = buildReader({
      'adminObservability.s3.buckets': ['local-bucket'],
      'adminObservability.s3.region': 'us-east-1',
      'adminObservability.s3.endpoint': 'localhost:9000',
      'adminObservability.s3.accessKey': 'access',
      'adminObservability.s3.secretKey': 'secret',
      'adminObservability.s3.maxObjects': 5,
      'adminObservability.s3.prefixes': [],
    })

    await reader.listRelatedObjects(buildCorrelation({ traceIds: ['trace-1'] }))

    expect(S3Client).toHaveBeenCalledWith({
      endpoint: 'http://localhost:9000',
      forcePathStyle: true,
      region: 'us-east-1',
      credentials: { accessKeyId: 'access', secretAccessKey: 'secret' },
    })
  })

  it('rejects partial static credentials instead of falling through to AWS credentials', async () => {
    const { reader } = buildReader({
      'adminObservability.s3.buckets': ['boxlite-dev-storage'],
      'adminObservability.s3.region': 'ap-southeast-1',
      'adminObservability.s3.endpoint': undefined,
      'adminObservability.s3.accessKey': 'access',
      'adminObservability.s3.secretKey': undefined,
      'adminObservability.s3.maxObjects': 25,
      'adminObservability.s3.prefixes': [],
    })

    const result = await reader.listRelatedObjects(buildCorrelation({ boxIds: ['box-1'] }))

    expect(result.status).toMatchObject({
      source: 's3',
      state: 'not_configured',
      message: 'Admin S3 lookup static credentials require both access key and secret key',
      count: 0,
    })
    expect(S3Client).not.toHaveBeenCalled()
  })
})
