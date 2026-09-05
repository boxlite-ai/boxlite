/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { VolumeManager } from './volume.manager'
import { RETIRED_VOLUME_STATES, VolumeState } from '../enums/volume-state.enum'

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

// The migration keeps the retired labels on the enum so instances on the
// previous release can still write during a rolling deploy. Those writes land
// after the migration's one-shot row conversion, so the reconciler is what
// stops them from being stranded — exactly the failure this refactor set out
// to remove.
describe('VolumeManager reconciles rows left behind by a rolling deploy', () => {
  function buildManager(volumes: { id: string; state: string }[]) {
    const find = jest.fn().mockResolvedValue(volumes)
    const update = jest.fn().mockResolvedValue(undefined)
    const redisLockProvider = {
      lock: jest.fn().mockResolvedValue(true),
      unlock: jest.fn().mockResolvedValue(undefined),
    }
    const manager = new VolumeManager(
      { find, update } as any,
      { get: jest.fn(), getOrThrow: jest.fn() } as any,
      {} as any,
      redisLockProvider as any,
      {} as any,
    )
    // The constructor bails before building the client when s3.endpoint is
    // unset; processPendingVolumes then returns immediately. Inject one so the
    // reconciliation path actually runs.
    ;(manager as any).s3Client = { send: jest.fn() }
    return { manager, find }
  }

  it('polls the retired labels alongside the current ones', async () => {
    const { manager, find } = buildManager([])

    await manager.processPendingVolumes()

    const polled = find.mock.calls[0][0].where.state._value as string[]
    expect(polled).toEqual(
      expect.arrayContaining([VolumeState.CREATING, VolumeState.DESTROYING, ...RETIRED_VOLUME_STATES]),
    )
    // 'deleted'/'destroyed' are terminal: polling them would re-run reclamation
    // on rows that are already done.
    expect(polled).not.toContain('deleted')
    expect(polled).not.toContain(VolumeState.DESTROYED)
  })

  it.each([
    ['pending_create', 'handleCreating'],
    ['pending_delete', 'handleDestroying'],
    ['deleting', 'handleDestroying'],
  ])('routes a legacy %s row to %s', async (state, handler) => {
    const { manager } = buildManager([{ id: 'vol-1', state }])
    const spy = jest.spyOn(manager as any, handler).mockResolvedValue(undefined)

    await manager.processPendingVolumes()

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toMatchObject({ id: 'vol-1', state })
  })
})
