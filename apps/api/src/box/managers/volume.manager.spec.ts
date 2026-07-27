/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { VolumeManager } from './volume.manager'
import {
  CreateAccessPointCommand,
  DeleteAccessPointCommand,
  DescribeAccessPointsCommand,
  EFSClient,
} from '@aws-sdk/client-efs'
import { VolumeBackend } from '../enums/volume-backend.enum'
import { rm } from 'node:fs/promises'

const mockSend = jest.fn()
const mockEfsSend = jest.fn()
const mockRm = rm as jest.MockedFunction<typeof rm>

jest.mock('node:fs/promises', () => ({
  rm: jest.fn(),
}))

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  CreateBucketCommand: jest.fn().mockImplementation((input) => ({ input })),
  ListObjectsV2Command: jest.fn().mockImplementation((input) => ({ input })),
  PutBucketTaggingCommand: jest.fn().mockImplementation((input) => ({ input })),
}))

jest.mock('@aws-sdk/client-efs', () => ({
  EFSClient: jest.fn().mockImplementation(() => ({ send: mockEfsSend })),
  CreateAccessPointCommand: jest.fn().mockImplementation((input) => ({ input })),
  DeleteAccessPointCommand: jest.fn().mockImplementation((input) => ({ input })),
  DescribeAccessPointsCommand: jest.fn().mockImplementation((input) => ({ operation: 'describe', input })),
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

describe('VolumeManager EFS backend', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  function buildManager() {
    const values = {
      'efs.region': 'ap-southeast-1',
      'efs.fileSystemId': 'fs-0123456789abcdef0',
      'efs.mountPath': '/mnt/boxlite-volumes',
      environment: 'test',
    }
    const configService = {
      get: jest.fn((key: string) => values[key]),
      getOrThrow: jest.fn((key: string) => {
        const value = values[key]
        if (value === undefined) throw new Error(`Missing config: ${key}`)
        return value
      }),
    }
    return new VolumeManager({} as any, configService as any, {} as any, {} as any, {} as any)
  }

  it('creates an isolated access point and records the provider id', async () => {
    mockEfsSend
      .mockResolvedValueOnce({ AccessPointId: 'fsap-0123456789abcdef0' })
      .mockResolvedValueOnce({ AccessPoints: [{ LifeCycleState: 'available' }] })
    const manager = buildManager()
    const volume = {
      id: '7dbd27bb-4465-4d13-98e6-bc1f00ab94b8',
      organizationId: 'cc8c56eb-4b9d-4b7c-93d2-bdc6055c83fb',
      backend: VolumeBackend.EFS,
      sizeGiB: 20,
    } as any

    await (manager as any).createEfsVolume(volume)

    expect(EFSClient).toHaveBeenCalledWith({ region: 'ap-southeast-1' })
    expect(CreateAccessPointCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        FileSystemId: 'fs-0123456789abcdef0',
        ClientToken: volume.id,
        PosixUser: { Uid: 1000, Gid: 1000 },
        RootDirectory: expect.objectContaining({ Path: `/boxlite-volumes/${volume.id}` }),
      }),
    )
    expect(volume.providerResourceId).toBe('fsap-0123456789abcdef0')
    expect(DescribeAccessPointsCommand).toHaveBeenCalledWith({ AccessPointId: 'fsap-0123456789abcdef0' })
  })

  it('deletes the access point and waits until it is gone', async () => {
    mockEfsSend
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(Object.assign(new Error('not found'), { name: 'AccessPointNotFound' }))
    const manager = buildManager()

    await (manager as any).deleteEfsVolume({ id: 'volume-id', providerResourceId: 'fsap-deadbeef' })

    expect(DeleteAccessPointCommand).toHaveBeenCalledWith({ AccessPointId: 'fsap-deadbeef' })
    expect(DescribeAccessPointsCommand).toHaveBeenCalledWith({ AccessPointId: 'fsap-deadbeef' })
    expect(mockRm).toHaveBeenCalledWith('/mnt/boxlite-volumes/volume-id', { recursive: true, force: true })
  })

  it('removes an orphaned directory when access-point creation was incomplete', async () => {
    const manager = buildManager()

    await (manager as any).deleteEfsVolume({ id: 'orphaned-volume' })

    expect(mockRm).toHaveBeenCalledWith('/mnt/boxlite-volumes/orphaned-volume', { recursive: true, force: true })
    expect(DeleteAccessPointCommand).not.toHaveBeenCalled()
  })
})
