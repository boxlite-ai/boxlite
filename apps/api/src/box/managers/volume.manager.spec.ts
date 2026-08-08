/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { VolumeManager } from './volume.manager'

const mockSend = jest.fn()

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  CreateBucketCommand: jest.fn().mockImplementation((input) => ({ input })),
  ListObjectsV2Command: jest.fn().mockImplementation((input) => ({ input })),
  PutBucketTaggingCommand: jest.fn().mockImplementation((input) => ({ input })),
  ListObjectVersionsCommand: jest.fn().mockImplementation((input) => ({ operation: 'list-versions', input })),
  DeleteObjectsCommand: jest.fn().mockImplementation((input) => ({ operation: 'delete-objects', input })),
  DeleteBucketCommand: jest.fn().mockImplementation((input) => ({ operation: 'delete-bucket', input })),
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
    return new VolumeManager({} as any, configService as any, {} as any, {} as any)
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

describe('VolumeManager owned volume locks', () => {
  it('does not write an error state after the volume lease is lost', async () => {
    const abortController = new AbortController()
    const volume = {
      id: 'volume-1',
      organizationId: 'org-1',
      state: 'pending_create',
      getBucketName: () => 'bucket-1',
    }
    const volumeRepository = {
      save: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    }
    const manager = new VolumeManager(
      volumeRepository as any,
      {
        get: jest.fn((key: string) =>
          ({ 's3.endpoint': 'https://s3.example.com', skipConnections: true })[key],
        ),
        getOrThrow: jest.fn((key: string) =>
          ({ 's3.endpoint': 'https://s3.example.com', 's3.region': 'us-east-1' })[key],
        ),
      } as any,
      {} as any,
      {} as any,
    )
    const logger = { error: jest.fn() }
    Object.assign(manager as any, { logger })
    mockSend.mockImplementationOnce(async () => {
      abortController.abort(new Error('ownership was lost'))
    })

    await expect((manager as any).processVolumeState(volume, abortController.signal)).rejects.toThrow(
      'ownership was lost',
    )

    expect(volumeRepository.save).not.toHaveBeenCalled()
    expect(volumeRepository.update).not.toHaveBeenCalled()
  })

  it('holds and releases the worker and volume leases while processing a volume', async () => {
    mockSend.mockResolvedValue({})
    const volume = {
      id: 'volume-1',
      organizationId: 'org-1',
      state: 'pending_create',
      getBucketName: () => 'bucket-1',
    }
    const volumeRepository = {
      find: jest.fn().mockResolvedValue([volume]),
      save: jest.fn().mockResolvedValue(undefined),
    }
    const configService = {
      get: jest.fn((key: string) =>
        ({
          's3.endpoint': 'https://s3.example.com',
          's3.region': 'us-east-1',
          skipConnections: true,
        })[key],
      ),
      getOrThrow: jest.fn((key: string) =>
        ({ 's3.endpoint': 'https://s3.example.com', 's3.region': 'us-east-1' })[key],
      ),
    }
    const releaseWorkerLease = jest.fn()
    const releaseVolumeLease = jest.fn()
    const redisLockProvider = {
      acquireLease: jest
        .fn()
        .mockResolvedValueOnce({ release: releaseWorkerLease })
        .mockResolvedValueOnce({ release: releaseVolumeLease }),
    }
    const manager = new VolumeManager(
      volumeRepository as any,
      configService as any,
      redisLockProvider as any,
      {} as any,
    )

    await manager.processPendingVolumes()

    expect(redisLockProvider.acquireLease).toHaveBeenNthCalledWith(1, 'process-pending-volumes', 30)
    expect(redisLockProvider.acquireLease).toHaveBeenNthCalledWith(2, 'volume-state-volume-1', 30)
    expect(releaseVolumeLease).toHaveBeenCalled()
    expect(releaseWorkerLease).toHaveBeenCalled()
  })

  it('retries a create after the bucket was already created and reaches ready', async () => {
    const alreadyCreated = Object.assign(new Error('already created'), { name: 'BucketAlreadyOwnedByYou' })
    mockSend.mockRejectedValueOnce(alreadyCreated).mockResolvedValueOnce({})
    const volume = {
      id: 'volume-1',
      organizationId: 'org-1',
      state: 'pending_create',
      getBucketName: () => 'bucket-1',
    }
    const volumeRepository = { save: jest.fn().mockResolvedValue(undefined), update: jest.fn() }
    const manager = new VolumeManager(
      volumeRepository as any,
      {
        get: jest.fn((key: string) =>
          ({ 's3.endpoint': 'https://s3.example.com', skipConnections: true, environment: 'test' })[key],
        ),
        getOrThrow: jest.fn((key: string) =>
          ({ 's3.endpoint': 'https://s3.example.com', 's3.region': 'us-east-1' })[key],
        ),
      } as any,
      {} as any,
      {} as any,
    )

    await (manager as any).processVolumeState(volume, new AbortController().signal)

    expect(volumeRepository.save).toHaveBeenCalledTimes(1)
    expect(volumeRepository.save).toHaveBeenCalledWith(expect.objectContaining({ state: 'ready' }))
  })

  it('keeps a deleted bucket pending when its lease is lost so the delete can retry', async () => {
    const ownershipError = new Error('ownership was lost')
    const abortController = new AbortController()
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockImplementationOnce(async () => {
        abortController.abort(ownershipError)
      })
    const volume = {
      id: 'volume-1',
      name: 'volume',
      organizationId: 'org-1',
      state: 'pending_delete',
      getBucketName: () => 'bucket-1',
    }
    const volumeRepository = {
      delete: jest.fn().mockResolvedValue(undefined),
      save: jest.fn().mockResolvedValue(undefined),
      update: jest.fn(),
    }
    const manager = new VolumeManager(
      volumeRepository as any,
      {
        get: jest.fn((key: string) =>
          ({ 's3.endpoint': 'https://s3.example.com', skipConnections: true })[key],
        ),
        getOrThrow: jest.fn((key: string) =>
          ({ 's3.endpoint': 'https://s3.example.com', 's3.region': 'us-east-1' })[key],
        ),
      } as any,
      {} as any,
      {} as any,
    )

    await expect((manager as any).processVolumeState(volume, abortController.signal)).rejects.toBe(ownershipError)

    expect(volumeRepository.delete).not.toHaveBeenCalled()
    expect(volumeRepository.save).not.toHaveBeenCalled()
    expect(volumeRepository.update).not.toHaveBeenCalled()
  })

  it('waits for sibling volume work before releasing the worker lease', async () => {
    const volumes = [
      { id: 'volume-1', state: 'pending_create' },
      { id: 'volume-2', state: 'pending_create' },
    ]
    const volumeRepository = { find: jest.fn().mockResolvedValue(volumes) }
    const releaseWorkerLease = jest.fn().mockResolvedValue(undefined)
    const redisLockProvider = {
      acquireLease: jest
        .fn()
        .mockResolvedValueOnce({ release: releaseWorkerLease })
        .mockResolvedValueOnce({ release: jest.fn().mockResolvedValue(undefined) })
        .mockResolvedValueOnce({ release: jest.fn().mockResolvedValue(undefined) }),
    }
    const manager = new VolumeManager(
      volumeRepository as any,
      {
        get: jest.fn((key: string) =>
          ({ 's3.endpoint': 'https://s3.example.com', skipConnections: true })[key],
        ),
        getOrThrow: jest.fn((key: string) =>
          ({ 's3.endpoint': 'https://s3.example.com', 's3.region': 'us-east-1' })[key],
        ),
      } as any,
      redisLockProvider as any,
      {} as any,
    )
    const logger = { error: jest.fn() }
    Object.assign(manager as any, { logger })
    let finishSecond!: () => void
    jest.spyOn(manager as any, 'processVolumeState').mockImplementation((volume: { id: string }) => {
      if (volume.id === 'volume-1') {
        return Promise.reject(new Error('volume lease lost'))
      }
      return new Promise<void>((resolve) => {
        finishSecond = resolve
      })
    })

    const processing = manager.processPendingVolumes()
    while (!finishSecond) {
      await Promise.resolve()
    }
    await Promise.resolve()
    expect(releaseWorkerLease).not.toHaveBeenCalled()

    finishSecond()
    await processing
    expect(releaseWorkerLease).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith('Error processing pending volumes:', expect.any(Error))
  })
})
