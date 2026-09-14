/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Logger } from '@nestjs/common'
import { S3Client, CreateBucketCommand, PutBucketTaggingCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { Storage } from '@google-cloud/storage'
import { TypedConfigService } from '../../config/typed-config.service'
import { deleteS3Bucket } from '../../common/utils/delete-s3-bucket'

/**
 * Raised by `destroy` when the bucket still holds objects. The two backends
 * signal this differently — S3 with a `BucketNotEmpty` error name, GCS with a
 * 409 — so it is normalised here; a caller that branched on either backend's
 * native shape would silently stop handling the case on the other.
 */
export class VolumeBucketNotEmptyError extends Error {
  constructor(bucket: string) {
    super(`Volume bucket ${bucket} is not empty`)
    this.name = 'VolumeBucketNotEmptyError'
  }
}

/**
 * The object-store operations a volume's lifecycle needs. One volume is one
 * bucket, so the whole surface is create/destroy plus a boot-time reachability
 * probe.
 */
export interface VolumeBucketStore {
  /** Fail fast at boot rather than on the first volume a user creates. */
  probe(): Promise<void>
  create(bucket: string, labels: Record<string, string>): Promise<void>
  /** Idempotent: a bucket that is already gone resolves rather than throwing. */
  destroy(bucket: string): Promise<void>
}

/**
 * Whether volumes can be served at all. Both the request path and the
 * reconciler need this answer and they must not drift: a request accepted by
 * one and refused by the other leaves a volume stuck in PENDING_CREATE.
 */
export function isVolumeStorageConfigured(configService: TypedConfigService): boolean {
  if (configService.get('volume.storageBackend') === 'gcs') {
    return true
  }
  return Boolean(configService.get('s3.endpoint'))
}

/**
 * Builds the store for the configured backend, or null when object storage is
 * not configured at all — the caller uses that to keep the whole volume
 * subsystem dormant, which is how an API without S3_ENDPOINT behaves today.
 */
export function createVolumeBucketStore(configService: TypedConfigService): VolumeBucketStore | null {
  const backend = configService.get('volume.storageBackend')

  // The runner applies default:"s3" before validate:"oneof=s3 gcs", so an unset
  // value is the S3 backend on both sides. A value that is set but unrecognised
  // is a typo, and staying silent would keep the API on S3 while the runner
  // refuses to boot — the two would then disagree about where a volume lives.
  if (backend && backend !== 's3' && backend !== 'gcs') {
    throw new Error(`VOLUME_STORAGE_BACKEND must be "s3" or "gcs", got "${backend}"`)
  }

  if (backend === 'gcs') {
    // getOrThrow only rejects undefined, but an unset key in a .env file is the
    // empty string and a fat-fingered one is whitespace. Either would reach
    // createBucket as a blank location and place every volume bucket in the
    // client's default region, failing at the first user volume instead of at
    // boot. Trimmed here as well as in configuration.ts: the guard that throws
    // should not depend on its caller having normalised the value.
    const location = configService.get('gcs.location')?.trim()
    if (!location) {
      throw new Error('GCS_LOCATION must be set when VOLUME_STORAGE_BACKEND is "gcs"')
    }
    return new GcsVolumeBucketStore(location, configService.get('gcs.projectId')?.trim() || undefined)
  }

  if (!isVolumeStorageConfigured(configService)) {
    return null
  }
  return new S3VolumeBucketStore(configService)
}

class S3VolumeBucketStore implements VolumeBucketStore {
  private readonly logger = new Logger(S3VolumeBucketStore.name)
  private readonly client: S3Client
  private readonly probeBucket?: string

  constructor(configService: TypedConfigService) {
    const endpoint = configService.getOrThrow('s3.endpoint')
    const region = configService.getOrThrow('s3.region')
    const accessKeyId = configService.get('s3.accessKey')
    const secretAccessKey = configService.get('s3.secretKey')

    // Both-or-neither: a lone key is a typo'd pair, and silently falling back
    // to the SDK default chain would mask the misconfig.
    if ((accessKeyId && !secretAccessKey) || (!accessKeyId && secretAccessKey)) {
      throw new Error('S3_ACCESS_KEY and S3_SECRET_KEY must be set together')
    }
    // MinIO cannot use the SDK default chain — fail fast at boot with a clear
    // message instead of a generic auth error from the connection probe.
    if (endpoint.includes('minio') && !accessKeyId) {
      throw new Error('MinIO requires S3_ACCESS_KEY and S3_SECRET_KEY to be configured')
    }

    this.probeBucket = configService.get('s3.defaultBucket')
    this.client = new S3Client({
      endpoint: endpoint.startsWith('http') ? endpoint : `http://${endpoint}`,
      region,
      // Static keys for S3-compatible deployments (MinIO); unset on AWS,
      // where the SDK default chain supplies the ECS task-role credentials.
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
      forcePathStyle: true,
    })
  }

  async probe(): Promise<void> {
    // Probe a bucket we already know instead of ListBuckets: same
    // connectivity+auth signal, but needs no account-wide
    // s3:ListAllMyBuckets grant on the task role.
    if (!this.probeBucket) {
      return
    }
    await this.client.send(new ListObjectsV2Command({ Bucket: this.probeBucket, MaxKeys: 1 }))
  }

  async create(bucket: string, labels: Record<string, string>): Promise<void> {
    await this.client.send(new CreateBucketCommand({ Bucket: bucket }))
    await this.client.send(
      new PutBucketTaggingCommand({
        Bucket: bucket,
        Tagging: { TagSet: Object.entries(labels).map(([Key, Value]) => ({ Key, Value })) },
      }),
    )
  }

  async destroy(bucket: string): Promise<void> {
    try {
      await deleteS3Bucket(this.client, bucket)
    } catch (error) {
      if (error.name === 'NoSuchBucket') {
        this.logger.warn(`Bucket ${bucket} does not exist, treating as already deleted`)
        return
      }
      if (error.name === 'BucketNotEmpty') {
        throw new VolumeBucketNotEmptyError(bucket)
      }
      throw error
    }
  }
}

class GcsVolumeBucketStore implements VolumeBucketStore {
  private readonly logger = new Logger(GcsVolumeBucketStore.name)
  private readonly storage: Storage

  constructor(
    private readonly location: string,
    projectId?: string,
  ) {
    // No credentials are passed: the client resolves Application Default
    // Credentials — the attached service account on GCE/GKE/Cloud Run, or
    // `gcloud auth application-default login` locally. Service-account key
    // files are deliberately not supported.
    this.storage = new Storage(projectId ? { projectId } : {})
  }

  async probe(): Promise<void> {
    // Minting a token is what actually exercises the credential chain — the
    // metadata server on GCE, or the ADC file locally. getProjectId() cannot
    // serve here: with projectId configured it returns the cached option
    // without touching credentials at all, so a broken chain would still boot.
    //
    // This proves credentials resolve, not that the bucket-admin role is
    // present; the first createBucket remains the check for that.
    await this.storage.authClient.getAccessToken()
  }

  async create(bucket: string, labels: Record<string, string>): Promise<void> {
    const [created] = await this.storage.createBucket(bucket, {
      location: this.location,
      // Volume buckets are private platform storage; uniform access removes
      // per-object ACLs as a way to widen that by accident.
      iamConfiguration: { uniformBucketLevelAccess: { enabled: true } },
      // GCS soft-deletes buckets and objects for seven days by default, so a
      // volume the user deleted would stay recoverable and billable long after
      // the state machine reports DELETED. S3 has no equivalent, and the
      // deletion a user asks for is meant to be the real one. 0 is the
      // documented disable value; every other accepted value is 7 to 90 days.
      // A string because that is the wire form the JSON API documents for this
      // field, and the client passes bucket metadata through untouched.
      softDeletePolicy: { retentionDurationSeconds: '0' },
    })

    /*
     * Confirm those three rather than assume them — see `checkAppliedSettings`.
     * A 2xx says the bucket exists, not that it is the bucket asked for.
     */
    const { wrong, unconfirmed } = checkAppliedSettings(created?.metadata, this.location)
    if (wrong.length > 0) {
      /*
       * Created, but not what was asked for. Deleted rather than kept: it is
       * empty at this instant so the delete is cheap and safe, and keeping it
       * would leave a billable bucket no volume record points at.
       *
       * The delete cannot change the outcome — the reason to fail is the
       * mismatch, and a cleanup error must not replace the message explaining
       * it — but it is reported, because a bucket left behind is exactly what
       * this guard exists to prevent.
       */
      try {
        await created?.delete()
      } catch (error) {
        // try/catch rather than a rejection handler: it also covers a response
        // that carried no `delete`, which would otherwise raise a TypeError
        // here and displace the mismatch this block exists to report.
        this.logger.warn(
          `Volume bucket ${bucket} was refused and could not be deleted; it is still billable: ${
            (error as Error)?.message ?? String(error)
          }`,
        )
      }
      throw new Error(`Volume bucket ${bucket} was not created as asked: ${wrong.join('; ')}`)
    }
    if (unconfirmed.length > 0) {
      // Far more likely a changed response shape than a policy the service
      // dropped, so the bucket stands and the loss of coverage is said out loud.
      this.logger.warn(
        `Volume bucket ${bucket} was created, but the response reported no ${unconfirmed.join(', no ')}; ` +
          'those settings were not verified',
      )
    }

    await this.storage.bucket(bucket).setLabels(toGcsLabels(labels), {})
  }

  async destroy(bucket: string): Promise<void> {
    const handle = this.storage.bucket(bucket)

    try {
      // GCS has no bulk delete; deleteFiles pages and deletes. `force` keeps it
      // going past individual failures so one stuck object cannot strand the
      // whole volume — but it also changes the rejection shape to an array of
      // per-object errors, which is why this cannot share the catch below.
      // No `versions`: volume buckets are created without object versioning.
      await handle.deleteFiles({ force: true })
    } catch (error) {
      // An object deleted concurrently reports 404 and leaves nothing to clean
      // up, so only the other failures are real.
      const failures = asErrorArray(error).filter((each) => statusOf(each) !== 404)
      if (failures.length > 0) {
        throw new Error(`Failed to empty volume bucket ${bucket}: ${failures.map((each) => each.message).join('; ')}`)
      }
    }

    try {
      await handle.delete()
    } catch (error) {
      if (statusOf(error) === 404) {
        this.logger.warn(`Bucket ${bucket} does not exist, treating as already deleted`)
        return
      }
      if (statusOf(error) === 409) {
        throw new VolumeBucketNotEmptyError(bucket)
      }
      throw error
    }
  }
}

/**
 * deleteFiles rejects with an array of per-object errors under `force`, and
 * with a single error everywhere else; both shapes reach the same handler.
 */
function asErrorArray(error: unknown): Error[] {
  return Array.isArray(error) ? error : [error as Error]
}

function statusOf(error: unknown): number | undefined {
  return (error as { code?: number } | undefined)?.code
}

/**
 * What the service applied, checked against what was asked for.
 *
 * `createBucket` resolves on a 2xx and the response was otherwise discarded, so
 * a setting the service did not apply read exactly like one it did — and each
 * of these three costs something real when it goes missing. Soft delete left at
 * the default keeps a volume the user deleted recoverable and billable for
 * seven days after the state machine reports DELETED. Uniform access left off
 * leaves per-object ACLs as a way to widen the bucket by accident. A location
 * that did not take puts every read a box makes in another region.
 *
 * A value that came back different is separated from one that did not come back
 * at all, because they are different failures. A wrong value means the service
 * did something other than what was asked, which is the case this exists for. A
 * missing field is far more likely to mean the client stopped echoing bucket
 * metadata — and failing every volume creation over a changed response shape
 * would be a worse outcome than losing the check, so that one warns.
 *
 * The distinction rests on an observation rather than an assumption: on
 * 2026-09-14 a `buckets.insert` against a real project answered
 * `softDeletePolicy: {"retentionDurationSeconds":"0"}`,
 * `iamConfiguration.uniformBucketLevelAccess.enabled: true` and
 * `location: "US-EAST5"` — all three present, the retention as a string. The
 * comparisons below are written for exactly that shape.
 *
 * Every disagreement is collected rather than the first returned: a bucket that
 * got none of the three is a different problem from one that missed one.
 */
function checkAppliedSettings(
  metadata: Record<string, any> | undefined,
  location: string,
): { wrong: string[]; unconfirmed: string[] } {
  const retention = metadata?.softDeletePolicy?.retentionDurationSeconds
  const uniform = metadata?.iamConfiguration?.uniformBucketLevelAccess?.enabled
  const applied = metadata?.location

  const wrong: string[] = []
  const unconfirmed: string[] = []

  // The API answers int64 fields as strings; compared as one rather than
  // trusting which side of that the client hands back.
  if (retention === undefined || retention === null) {
    unconfirmed.push('soft delete retention')
  } else if (String(retention) !== '0') {
    wrong.push(`soft delete retention is ${JSON.stringify(retention)}, want "0"`)
  }

  if (uniform === undefined || uniform === null) {
    unconfirmed.push('uniform bucket-level access')
  } else if (uniform !== true) {
    wrong.push(`uniform bucket-level access is ${JSON.stringify(uniform)}, want true`)
  }

  // GCS reports the location upper-cased; a stage names its region in the lower
  // case every other API uses.
  if (applied === undefined || applied === null || applied === '') {
    unconfirmed.push('location')
  } else if (String(applied).toUpperCase() !== location.toUpperCase()) {
    wrong.push(`location is ${JSON.stringify(applied)}, want ${JSON.stringify(location)}`)
  }

  return { wrong, unconfirmed }
}

/**
 * GCS labels accept only lowercase letters, digits, dashes and underscores, so
 * the S3 tag keys (`VolumeId`, `OrganizationId`, …) would be rejected verbatim.
 */
function toGcsLabels(labels: Record<string, string>): Record<string, string> {
  const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]/g, '-')
  return Object.fromEntries(Object.entries(labels).map(([key, value]) => [normalise(key), normalise(value)]))
}
