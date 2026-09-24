/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Logger } from '@nestjs/common'
import { Storage } from '@google-cloud/storage'
import { createVolumeBucketStore, VolumeBucketNotEmptyError } from './volume-bucket.store'

const mockCreateBucket = jest.fn()
const mockGetAccessToken = jest.fn()
const mockSetLabels = jest.fn()
const mockDeleteFiles = jest.fn()
const mockDeleteBucket = jest.fn()

const mockDeleteS3Bucket = jest.fn()

jest.mock('../../common/utils/delete-s3-bucket', () => ({
  deleteS3Bucket: (...args: unknown[]) => mockDeleteS3Bucket(...args),
}))

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    createBucket: mockCreateBucket,
    authClient: { getAccessToken: mockGetAccessToken },
    bucket: jest.fn(() => ({
      setLabels: mockSetLabels,
      deleteFiles: mockDeleteFiles,
      delete: mockDeleteBucket,
    })),
  })),
}))

/** A create response that echoes back everything `create` asked for. */
function createdBucket(overrides: Record<string, unknown> = {}) {
  return {
    metadata: {
      location: 'US-CENTRAL1',
      iamConfiguration: { uniformBucketLevelAccess: { enabled: true } },
      softDeletePolicy: { retentionDurationSeconds: '0' },
      ...overrides,
    },
    delete: mockDeleteBucket,
  }
}

function buildStore(values: Record<string, unknown>) {
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
  return createVolumeBucketStore(configService as any)
}

const gcsConfig = {
  'volume.storageBackend': 'gcs',
  'gcs.location': 'us-central1',
}

describe('createVolumeBucketStore', () => {
  afterEach(() => jest.clearAllMocks())

  // Compatibility: no VOLUME_STORAGE_BACKEND means the S3 path, which is also
  // the path that stays dormant when object storage is not configured at all.
  it('defaults to S3 and stays dormant when no endpoint is configured', () => {
    expect(buildStore({})).toBeNull()
    expect(buildStore({ 'volume.storageBackend': 's3' })).toBeNull()
    expect(Storage).not.toHaveBeenCalled()
  })

  it('builds an S3 store once an endpoint is configured', () => {
    const store = buildStore({
      's3.endpoint': 'https://s3.ap-southeast-1.amazonaws.com',
      's3.region': 'ap-southeast-1',
    })

    expect(store).not.toBeNull()
    expect(Storage).not.toHaveBeenCalled()
  })

  // A GCS deployment that forgets the location would otherwise silently land
  // every volume bucket in the client's default region, away from the runners.
  // A .env file spells an unset key as the empty string, not undefined, and
  // getOrThrow would wave that through into createBucket as location:''.
  it.each([undefined, '', '   '])('refuses a GCS backend whose location is %p', (location) => {
    const values: Record<string, unknown> = { 'volume.storageBackend': 'gcs' }
    if (location !== undefined) {
      values['gcs.location'] = location
    }
    expect(() => buildStore(values)).toThrow('GCS_LOCATION')
  })

  // The runner refuses an unknown backend at startup via validate:"oneof=s3 gcs".
  // Without the same refusal here a typo keeps the API quietly on S3 while the
  // runner will not boot, and the two disagree about where a volume lives.
  it.each(['gsc', 'GCS', 's3 ', 'filestore'])('refuses the unrecognised backend %p', (backend) => {
    expect(() => buildStore({ 'volume.storageBackend': backend, 's3.endpoint': 'http://minio:9000' })).toThrow(
      'VOLUME_STORAGE_BACKEND',
    )
  })

  // No credentials are passed anywhere: the client must resolve ADC.
  it('constructs the GCS client without credentials', () => {
    buildStore(gcsConfig)
    expect(Storage).toHaveBeenCalledWith({})

    jest.clearAllMocks()
    buildStore({ ...gcsConfig, 'gcs.projectId': 'boxlite-prod' })
    expect(Storage).toHaveBeenCalledWith({ projectId: 'boxlite-prod' })
  })
})

describe('GCS volume bucket store', () => {
  // clearAllMocks resets call records but not implementations, so each case
  // re-establishes the happy path; otherwise a rejection set by one case leaks
  // into the next and silently short-circuits the code under test.
  beforeEach(() => {
    mockGetAccessToken.mockResolvedValue('ya29.token')
    // The shape the real client returns — `[Bucket, apiResponse]`, the Bucket
    // carrying what the service actually applied. `create` reads it now, so a
    // mock that resolved `undefined` would exercise a path production never
    // takes.
    mockCreateBucket.mockResolvedValue([createdBucket()])
    mockSetLabels.mockResolvedValue(undefined)
    mockDeleteFiles.mockResolvedValue(undefined)
    mockDeleteBucket.mockResolvedValue(undefined)
  })

  afterEach(() => jest.clearAllMocks())

  // The point of the probe is to fail at boot when the credential chain is
  // broken. getProjectId() would have returned the cached option here and let
  // a misconfigured deployment start, so the assertion is the rejection, not
  // that some method was called.
  it('fails when the credential chain cannot mint a token', async () => {
    mockGetAccessToken.mockRejectedValue(new Error('Could not load the default credentials'))

    await expect(buildStore(gcsConfig).probe()).rejects.toThrow('default credentials')
  })

  it('passes once a token can be minted, without needing a storage grant', async () => {
    await expect(buildStore(gcsConfig).probe()).resolves.toBeUndefined()
    expect(mockGetAccessToken).toHaveBeenCalled()
  })

  // Soft delete is the one that has to be asked for: GCS applies a seven-day
  // retention to new buckets by default, so omitting the policy leaves a
  // deleted volume recoverable and billable after the state machine has
  // reported DELETED. Setting it on the create call is what stops a volume
  // bucket from ever existing with the default, so the whole argument is
  // pinned rather than just the location.
  it('creates the bucket in the configured location, with uniform access and no soft delete', async () => {
    await buildStore(gcsConfig).create('boxlite-volume-abc', {})

    expect(mockCreateBucket).toHaveBeenCalledWith('boxlite-volume-abc', {
      location: 'us-central1',
      iamConfiguration: { uniformBucketLevelAccess: { enabled: true } },
      softDeletePolicy: { retentionDurationSeconds: '0' },
    })
  })

  /*
   * The check that exists because the failure is invisible. `createBucket`
   * resolves on a 2xx whatever the service did with the metadata, so a policy
   * it ignored reads exactly like one it applied — and the cost lands weeks
   * later, on a bill or on data a user believed deleted.
   */
  it('refuses a bucket the service did not apply the soft-delete policy to', async () => {
    mockCreateBucket.mockResolvedValue([createdBucket({ softDeletePolicy: { retentionDurationSeconds: '604800' } })])

    await expect(buildStore(gcsConfig).create('boxlite-volume-abc', {})).rejects.toThrow(
      /soft delete retention is "604800", want "0"/,
    )
  })

  /*
   * Absence is treated as a changed response shape, not as a policy the service
   * dropped — a `buckets.insert` against a real project answers all three, so a
   * field that stops arriving says more about the client than about the bucket.
   * Failing every volume creation over that would cost more than the check is
   * worth, so the bucket stands and the lost coverage is logged.
   */
  it('keeps a bucket whose settings came back missing, and says they went unverified', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    mockCreateBucket.mockResolvedValue([{ metadata: {}, delete: mockDeleteBucket }])

    await expect(buildStore(gcsConfig).create('boxlite-volume-abc', {})).resolves.toBeUndefined()
    expect(mockDeleteBucket).not.toHaveBeenCalled()
    expect(mockSetLabels).toHaveBeenCalled()
    expect(warn.mock.calls.flat().join(' ')).toMatch(/no soft delete retention.*not verified/s)
    warn.mockRestore()
  })

  // Empty at this instant, so leaving it would be a billable bucket no volume
  // record points at — and the labels must not be written to something that is
  // about to be thrown away.
  it('deletes the bucket it refuses, and never labels it', async () => {
    mockCreateBucket.mockResolvedValue([
      createdBucket({ iamConfiguration: { uniformBucketLevelAccess: { enabled: false } } }),
    ])

    await expect(buildStore(gcsConfig).create('boxlite-volume-abc', {})).rejects.toThrow(/uniform bucket-level access/)
    expect(mockDeleteBucket).toHaveBeenCalled()
    expect(mockSetLabels).not.toHaveBeenCalled()
  })

  /*
   * The branch that would otherwise be silent. A refused bucket that also fails
   * to delete is the exact thing this guard exists to prevent — billable, and
   * pointed at by no volume record — so it cannot go unreported, and the
   * cleanup error must not displace the mismatch that caused the refusal.
   */
  it('reports a refused bucket it could not delete, without losing the reason', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    mockCreateBucket.mockResolvedValue([createdBucket({ location: 'EUROPE-WEST1' })])
    mockDeleteBucket.mockRejectedValue(new Error('deletion protection'))

    await expect(buildStore(gcsConfig).create('boxlite-volume-abc', {})).rejects.toThrow(/location is "EUROPE-WEST1"/)
    expect(warn.mock.calls.flat().join(' ')).toMatch(/could not be deleted.*still billable.*deletion protection/s)
    warn.mockRestore()
  })

  // A response shape that carried no `delete` would otherwise raise a TypeError
  // from the cleanup and lose the reason the bucket was refused in the first
  // place — which is the one thing this path must not do.
  it('keeps the reason when the response cannot even be cleaned up', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    mockCreateBucket.mockResolvedValue([{ metadata: createdBucket({ location: 'EUROPE-WEST1' }).metadata }])

    await expect(buildStore(gcsConfig).create('boxlite-volume-abc', {})).rejects.toThrow(/location is "EUROPE-WEST1"/)
    expect(warn.mock.calls.flat().join(' ')).toMatch(/could not be deleted/)
    warn.mockRestore()
  })

  // GCS labels reject the S3 tag keys verbatim: uppercase is not allowed. A
  // pass-through would fail the create, not merely lose the labels.
  it('normalises S3 tag keys into GCS label syntax', async () => {
    await buildStore(gcsConfig).create('boxlite-volume-abc', {
      VolumeId: 'abc-123',
      OrganizationId: 'org-1',
      Environment: 'Dev',
    })

    expect(mockSetLabels).toHaveBeenCalledWith({ volumeid: 'abc-123', organizationid: 'org-1', environment: 'dev' }, {})
  })

  // Order is the assertion: GCS refuses to delete a non-empty bucket with a
  // 409, so a reordering would surface as a failed volume deletion in
  // production while both calls still "happened".
  it('deletes objects before the bucket', async () => {
    const order: string[] = []
    mockDeleteFiles.mockImplementation(async () => void order.push('files'))
    mockDeleteBucket.mockImplementation(async () => void order.push('bucket'))

    await buildStore(gcsConfig).destroy('boxlite-volume-abc')

    expect(mockDeleteFiles).toHaveBeenCalledWith({ force: true })
    expect(order).toEqual(['files', 'bucket'])
  })

  // Deletion is retried by the volume state machine, so a bucket that a prior
  // attempt already removed must not wedge the volume in DELETING forever.
  it('treats an already-deleted bucket as success', async () => {
    mockDeleteBucket.mockRejectedValue(Object.assign(new Error('Not Found'), { code: 404 }))

    await expect(buildStore(gcsConfig).destroy('boxlite-volume-abc')).resolves.toBeUndefined()
  })

  // Under `force` deleteFiles rejects with an ARRAY of per-object errors, so a
  // handler that reads error.code off the rejection sees undefined, skips
  // every branch, and reports the failure as `undefined` to the caller.
  it('reports per-object delete failures instead of an empty error', async () => {
    mockDeleteFiles.mockRejectedValue([
      Object.assign(new Error('retention policy'), { code: 403 }),
      Object.assign(new Error('still uploading'), { code: 412 }),
    ])

    const destroy = buildStore(gcsConfig).destroy('boxlite-volume-abc')

    await expect(destroy).rejects.toThrow(/retention policy; still uploading/)
    expect(mockDeleteBucket).not.toHaveBeenCalled()
  })

  // An object deleted concurrently leaves nothing to clean up, so the bucket
  // delete must still run rather than the volume failing on a benign race.
  it('ignores objects that vanished mid-delete', async () => {
    mockDeleteFiles.mockRejectedValue([Object.assign(new Error('Not Found'), { code: 404 })])

    await expect(buildStore(gcsConfig).destroy('boxlite-volume-abc')).resolves.toBeUndefined()
    expect(mockDeleteBucket).toHaveBeenCalled()
  })

  // The manager branches on this type to produce a retryable user-facing
  // message; a raw 409 would fall through to the generic error path.
  it('maps a non-empty bucket onto the shared error type', async () => {
    mockDeleteBucket.mockRejectedValue(Object.assign(new Error('conflict'), { code: 409 }))

    await expect(buildStore(gcsConfig).destroy('boxlite-volume-abc')).rejects.toBeInstanceOf(VolumeBucketNotEmptyError)
  })

  it('rethrows anything else', async () => {
    mockDeleteBucket.mockRejectedValue(Object.assign(new Error('permission denied'), { code: 403 }))

    await expect(buildStore(gcsConfig).destroy('boxlite-volume-abc')).rejects.toThrow('permission denied')
  })
})

describe('S3 volume bucket store', () => {
  const s3Config = {
    's3.endpoint': 'https://s3.ap-southeast-1.amazonaws.com',
    's3.region': 'ap-southeast-1',
  }

  afterEach(() => jest.clearAllMocks())

  // Deletion is retried by the volume state machine; a bucket a prior attempt
  // already removed must not wedge the volume in DELETING.
  it('treats an already-deleted bucket as success', async () => {
    mockDeleteS3Bucket.mockRejectedValue(Object.assign(new Error('gone'), { name: 'NoSuchBucket' }))

    await expect(buildStore(s3Config).destroy('boxlite-volume-abc')).resolves.toBeUndefined()
  })

  // Both backends must raise the same type: the manager turns it into the
  // retryable user-facing message and would otherwise fall through to the
  // generic error path on one backend only.
  it('maps a non-empty bucket onto the shared error type', async () => {
    mockDeleteS3Bucket.mockRejectedValue(Object.assign(new Error('not empty'), { name: 'BucketNotEmpty' }))

    await expect(buildStore(s3Config).destroy('boxlite-volume-abc')).rejects.toBeInstanceOf(VolumeBucketNotEmptyError)
  })

  it('rethrows anything else', async () => {
    mockDeleteS3Bucket.mockRejectedValue(Object.assign(new Error('access denied'), { name: 'AccessDenied' }))

    await expect(buildStore(s3Config).destroy('boxlite-volume-abc')).rejects.toThrow('access denied')
  })
})
