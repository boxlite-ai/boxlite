/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CreateBucketCommand, ListObjectsV2Command, PutBucketTaggingCommand, S3Client } from '@aws-sdk/client-s3'
import { Volume } from '../entities/volume.entity'
import { VolumeState } from '../enums/volume-state.enum'
import * as deleteS3BucketUtils from '../../common/utils/delete-s3-bucket'
import { VolumeManager } from './volume.manager'

const mockSend = jest.fn()

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  CreateBucketCommand: jest.fn().mockImplementation((input) => ({ input })),
  ListObjectsV2Command: jest.fn().mockImplementation((input) => ({ input })),
  PutBucketTaggingCommand: jest.fn().mockImplementation((input) => ({ input })),
}))

describe('VolumeManager S3 client setup', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  function buildManager(values: Record<string, unknown>) {
    const configService = {
      get: jest.fn((key: string) => values[key]),
      getOrThrow: jest.fn((key: string) => {
        const value = values[key]
        if (value === undefined) {
          throw new Error(`Missing config: ${key}`)
        }
        return value
      }),
    }
    return new VolumeManager({} as any, configService as any, {} as any, {} as any, {} as any)
  }

  const awsConfig = {
    's3.endpoint': 'https://s3.ap-southeast-1.amazonaws.com',
    's3.region': 'ap-southeast-1',
    's3.defaultBucket': 'boxlite-dev-storage',
  }

  it('uses the SDK default chain and probes the known bucket instead of ListBuckets', async () => {
    mockSend.mockResolvedValue({})
    const manager = buildManager(awsConfig)

    await manager.onModuleInit()

    // No `credentials` key at all → SDK default chain (ECS task role).
    expect(S3Client).toHaveBeenCalledWith({
      endpoint: 'https://s3.ap-southeast-1.amazonaws.com',
      region: 'ap-southeast-1',
      forcePathStyle: true,
    })
    // Scoped probe: no account-wide s3:ListAllMyBuckets needed.
    expect(ListObjectsV2Command).toHaveBeenCalledWith({ Bucket: 'boxlite-dev-storage', MaxKeys: 1 })
  })

  it('still passes static keys through when configured', () => {
    buildManager({ ...awsConfig, 's3.accessKey': 'static-id', 's3.secretKey': 'static-secret' })

    expect(S3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: { accessKeyId: 'static-id', secretAccessKey: 'static-secret' },
      }),
    )
  })

  it('skips the probe when no default bucket is configured', async () => {
    const manager = buildManager({ 's3.endpoint': 'http://s3-compatible.local:9000', 's3.region': 'us-east-1' })

    await manager.onModuleInit()

    expect(ListObjectsV2Command).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('rejects a lone static key instead of silently using the default chain', () => {
    expect(() => buildManager({ ...awsConfig, 's3.accessKey': 'static-id' })).toThrow(
      /S3_ACCESS_KEY and S3_SECRET_KEY must be set together/,
    )
  })

  it('fails fast when MinIO is configured without static keys', () => {
    expect(() => buildManager({ 's3.endpoint': 'http://minio:9000', 's3.region': 'us-east-1' })).toThrow(
      /MinIO requires S3_ACCESS_KEY and S3_SECRET_KEY/,
    )
  })

  it('creates buckets using the configured volume bucket prefix and volume id', async () => {
    mockSend.mockResolvedValue({})
    const volume = new Volume()
    volume.id = 'volume-1'
    volume.organizationId = 'org-1'
    volume.state = VolumeState.PENDING_CREATE

    const volumeRepository = {
      find: jest.fn(async () => [volume]),
      save: jest.fn(async (value) => value),
    }
    const redis = { setex: jest.fn() }
    const redisLockProvider = {
      lock: jest.fn(async () => true),
      unlock: jest.fn(async () => undefined),
    }
    const manager = new VolumeManager(
      volumeRepository as any,
      {
        get: jest.fn((key: string) => ({ ...awsConfig, 's3.volumeBucketPrefix': 'boxlite-dev-volume-', environment: 'test' })[key]),
        getOrThrow: jest.fn((key: string) => ({ ...awsConfig, 's3.volumeBucketPrefix': 'boxlite-dev-volume-', environment: 'test' })[key]),
      } as any,
      redis as any,
      redisLockProvider as any,
      {} as any,
    )

    await manager.processPendingVolumes()

    expect(CreateBucketCommand).toHaveBeenCalledWith({ Bucket: 'boxlite-dev-volume-volume-1' })
    expect(PutBucketTaggingCommand).toHaveBeenCalledWith(
      expect.objectContaining({ Bucket: 'boxlite-dev-volume-volume-1' }),
    )
  })

  it('deletes buckets using the configured volume bucket prefix and volume id', async () => {
    const deleteBucket = jest.spyOn(deleteS3BucketUtils, 'deleteS3Bucket').mockResolvedValue(undefined)
    try {
      const volume = new Volume()
      volume.id = 'volume-1'
      volume.organizationId = 'org-1'
      volume.name = 'data'
      volume.state = VolumeState.PENDING_DELETE

      const volumeRepository = {
        find: jest.fn(async () => [volume]),
        delete: jest.fn(async () => undefined),
        save: jest.fn(async (value) => value),
      }
      const redis = { setex: jest.fn() }
      const redisLockProvider = {
        lock: jest.fn(async () => true),
        unlock: jest.fn(async () => undefined),
      }
      const manager = new VolumeManager(
        volumeRepository as any,
        {
          get: jest.fn((key: string) => ({ ...awsConfig, 's3.volumeBucketPrefix': 'boxlite-dev-volume-' })[key]),
          getOrThrow: jest.fn((key: string) => ({ ...awsConfig, 's3.volumeBucketPrefix': 'boxlite-dev-volume-' })[key]),
        } as any,
        redis as any,
        redisLockProvider as any,
        {} as any,
      )

      await manager.processPendingVolumes()

      expect(deleteBucket).toHaveBeenCalledWith(expect.anything(), 'boxlite-dev-volume-volume-1')
    } finally {
      deleteBucket.mockRestore()
    }
  })
})
