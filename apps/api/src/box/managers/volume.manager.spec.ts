/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { VolumeManager } from './volume.manager'
import { EC2Client, CreateVolumeCommand, DeleteVolumeCommand } from '@aws-sdk/client-ec2'
import { VolumeBackend } from '../enums/volume-backend.enum'

const mockSend = jest.fn()
const mockEc2Send = jest.fn()
const mockWaitAvailable = jest.fn()
const mockWaitDeleted = jest.fn()

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  CreateBucketCommand: jest.fn().mockImplementation((input) => ({ input })),
  ListObjectsV2Command: jest.fn().mockImplementation((input) => ({ input })),
  PutBucketTaggingCommand: jest.fn().mockImplementation((input) => ({ input })),
}))

jest.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: jest.fn().mockImplementation(() => ({ send: mockEc2Send })),
  CreateVolumeCommand: jest.fn().mockImplementation((input) => ({ input })),
  DeleteVolumeCommand: jest.fn().mockImplementation((input) => ({ input })),
  waitUntilVolumeAvailable: (...args: unknown[]) => mockWaitAvailable(...args),
  waitUntilVolumeDeleted: (...args: unknown[]) => mockWaitDeleted(...args),
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

describe('VolumeManager EBS backend', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  function buildManager() {
    const values = {
      'ebs.region': 'ap-southeast-1',
      'ebs.availabilityZone': 'ap-southeast-1a',
      'ebs.volumeType': 'gp3',
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

  it('creates an encrypted volume in the runner availability zone and records the provider id', async () => {
    mockEc2Send.mockResolvedValue({ VolumeId: 'vol-0123456789abcdef0' })
    mockWaitAvailable.mockResolvedValue({ state: 'SUCCESS' })
    const manager = buildManager()
    const volume = {
      id: '7dbd27bb-4465-4d13-98e6-bc1f00ab94b8',
      organizationId: 'cc8c56eb-4b9d-4b7c-93d2-bdc6055c83fb',
      backend: VolumeBackend.EBS,
      sizeGiB: 20,
    } as any

    await (manager as any).createEbsVolume(volume)

    expect(EC2Client).toHaveBeenCalledWith({ region: 'ap-southeast-1' })
    expect(CreateVolumeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        AvailabilityZone: 'ap-southeast-1a',
        ClientToken: volume.id,
        Encrypted: true,
        Size: 20,
        VolumeType: 'gp3',
      }),
    )
    expect(volume.providerResourceId).toBe('vol-0123456789abcdef0')
    expect(mockWaitAvailable).toHaveBeenCalled()
  })

  it('deletes the provider volume and waits until it is gone', async () => {
    mockEc2Send.mockResolvedValue({})
    mockWaitDeleted.mockResolvedValue({ state: 'SUCCESS' })
    const manager = buildManager()

    await (manager as any).deleteEbsVolume({ id: 'volume-id', providerResourceId: 'vol-deadbeef' })

    expect(DeleteVolumeCommand).toHaveBeenCalledWith({ VolumeId: 'vol-deadbeef' })
    expect(mockWaitDeleted).toHaveBeenCalled()
  })
})
