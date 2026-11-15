/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { VolumeState } from '../enums/volume-state.enum'
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
})

describe('VolumeManager filestore volume deletion', () => {
  function buildManagerForDeletion() {
    const configService = {
      get: jest.fn(() => undefined),
      getOrThrow: jest.fn(() => {
        throw new Error('Missing config')
      }),
    }
    const volumeRepository = {
      save: jest.fn().mockImplementation(async (v) => v),
      delete: jest.fn().mockResolvedValue({}),
    }
    const redis = { setex: jest.fn().mockResolvedValue(1) }
    return {
      manager: new VolumeManager(volumeRepository as any, configService as any, redis as any, {} as any, {} as any),
      volumeRepository,
    }
  }

  it('lands a filestore volume DELETED without any bucket operation', async () => {
    // No storage backend is configured at all (bucketStore is null): the
    // filestore branch must not need one, and the DELETED landing is the same
    // tombstone + rename the bucket path uses.
    const { manager, volumeRepository } = buildManagerForDeletion()
    const volume = {
      id: 'volume-1',
      organizationId: 'org-1',
      name: 'nfs-data',
      state: VolumeState.PENDING_DELETE,
      instance: 'ml-scratch',
    } as any

    await (manager as any).handlePendingDelete(volume, 'lock-key')

    expect(volumeRepository.save).toHaveBeenNthCalledWith(2, expect.objectContaining({
      id: 'volume-1',
      state: VolumeState.DELETED,
      name: 'nfs-data-deleted',
    }))
    expect(volumeRepository.delete).toHaveBeenCalledWith({
      organizationId: 'org-1',
      name: 'nfs-data-deleted',
      state: VolumeState.DELETED,
    })
  })
})
