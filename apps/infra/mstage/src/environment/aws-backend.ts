/**
 * AWS environment values retain the existing SSM bootstrap/passphrase and S3 secret keys.
 * Deployment checkpoints and locks use Pulumi DIY paths in the same bucket.
 * SST checkpoints are read only as migration evidence; this backend never rewrites them.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { IAMClient } from '@aws-sdk/client-iam'
import { awsOwnership } from './aws-ownership.ts'
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { EnvError, objectKey, type StoreBackend, type StoredVersion } from './backend.ts'
import type { AwsIdentity } from '../aws/identity.ts'
import { pulumiCheckpointKey as checkpointKey, pulumiLockPrefix } from './pulumi-state.ts'

const BOOTSTRAP_PARAMETER = '/sst/bootstrap'

export type AwsClients = {
  iam?: { send: (command: any) => Promise<any> }
  s3: { send: (command: any) => Promise<any> }
  ssm: { send: (command: any) => Promise<any> }
}

export const clientsFor = (identity: Pick<AwsIdentity, 'credentials' | 'region'>): AwsClients => {
  const config = { region: identity.region, credentials: identity.credentials }
  return { s3: new S3Client(config), ssm: new SSMClient(config), iam: new IAMClient(config) }
}

/**
 * Clients for a caller that has no mstage identity to hand — a container
 * holding a task role, where the SDK's own chain is already the right answer.
 */
export const ambientClients = (region: string): AwsClients => ({
  iam: new IAMClient({ region }),
  s3: new S3Client({ region }),
  ssm: new SSMClient({ region }),
})

const isNotFound = (error: unknown): boolean => {
  const name = (error as { name?: string })?.name
  return name === 'NoSuchKey' || name === 'NotFound' || name === 'ParameterNotFound'
}

/** The state bucket for this region. Nothing else records its random suffix. */
export const readStateBucket = async (clients: AwsClients): Promise<string> => {
  let answer
  try {
    answer = await clients.ssm.send(new GetParameterCommand({ Name: BOOTSTRAP_PARAMETER, WithDecryption: false }))
  } catch (error) {
    if (isNotFound(error)) {
      throw new EnvError(`${BOOTSTRAP_PARAMETER} does not exist in this region; the account was never bootstrapped`)
    }
    throw error
  }
  let bootstrap: { state?: string }
  try {
    bootstrap = JSON.parse(answer.Parameter?.Value ?? '')
  } catch {
    throw new EnvError(`${BOOTSTRAP_PARAMETER} is not valid JSON`)
  }
  if (!bootstrap.state) throw new EnvError(`${BOOTSTRAP_PARAMETER} names no state bucket`)
  return bootstrap.state
}

/** Discover every operation lock, including listings larger than a single S3 page. */
const lockFiles = async (clients: AwsClients, app: string, stage: string): Promise<string[]> => {
  const bucket = await readStateBucket(clients)
  const prefix = pulumiLockPrefix(app, stage)
  const keys: string[] = []
  let token: string | undefined
  do {
    const answer = await clients.s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    )
    for (const object of answer.Contents ?? []) {
      if (typeof object.Key === 'string' && object.Key.startsWith(prefix)) keys.push(object.Key)
    }
    const next = answer.IsTruncated ? answer.NextContinuationToken : undefined
    if (answer.IsTruncated && (!next || next === token)) throw new EnvError('The S3 lock listing returned no next page')
    token = next
  } while (token)
  return [...new Set(keys)].sort()
}

/** One object as stored, or null when it is not there. Neither of these is sealed. */
const readObject = async (clients: AwsClients, key: string): Promise<Buffer | null> => {
  const bucket = await readStateBucket(clients)
  let answer
  try {
    answer = await clients.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
  const payload = Buffer.from(await answer.Body.transformToByteArray())
  return payload.length === 0 ? null : payload
}

export const awsBackend = (clients: AwsClients): StoreBackend => ({
  home: 'aws',
  async edit(scope, work) {
    const Bucket = await readStateBucket(clients)
    const Key = objectKey(scope.app, scope.stage)
    for (let attempt = 0; attempt < 8; attempt++) {
      let etag: string | null | undefined
      const snapshot: StoreBackend = {
        ...awsBackend(clients),
        edit: undefined,
        async read() {
          let answer
          try {
            answer = await clients.s3.send(new GetObjectCommand({ Bucket, Key }))
          } catch (error) {
            if (!isNotFound(error)) throw error
            etag = null
            return null
          }
          if (!answer.ETag) throw new EnvError(`${Key} has no ETag; cannot safely edit it`)
          etag = answer.ETag
          const bytes = Buffer.from(await answer.Body.transformToByteArray())
          return bytes.length ? bytes : null
        },
        async write({ sealed }) {
          if (etag === undefined) throw new EnvError('A conditional stage edit requires an observed revision')
          await clients.s3.send(
            new PutObjectCommand({
              Bucket,
              Key,
              Body: sealed,
              ContentType: 'application/json',
              ...(etag === null ? { IfNoneMatch: '*' } : { IfMatch: etag }),
            }),
          )
        },
      }
      try {
        return await work(snapshot)
      } catch (error: any) {
        if (
          !['PreconditionFailed', 'ConditionalRequestConflict'].includes(error?.name) &&
          ![409, 412].includes(error?.$metadata?.httpStatusCode)
        )
          throw error
      }
    }
    throw new EnvError(`${Key} kept changing; retry after concurrent writes finish`)
  },
  ownership: awsOwnership({
    s3: clients.s3,
    stateBucket: () => readStateBucket(clients),
    iam: clients.iam ?? {
      send: async () => {
        throw new EnvError('AWS ownership requires an IAM client')
      },
    },
  }),

  async read({ app, stage, versionId }) {
    const bucket = await readStateBucket(clients)
    const key = objectKey(app, stage)
    let answer
    try {
      answer = await clients.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }))
    } catch (error) {
      if (!isNotFound(error)) throw error
      // An unwritten stage is empty rather than an error, as SST reports it. A
      // *pinned* version that has gone is not: answering empty there starts a
      // caller with nothing at the moment it asked for something specific.
      if (versionId) throw new EnvError(`${key} has no version ${versionId}; it was deleted or expired`)
      return null
    }
    const payload = Buffer.from(await answer.Body.transformToByteArray())
    return payload.length === 0 ? null : payload
  },

  async write({ app, stage, sealed }) {
    const bucket = await readStateBucket(clients)
    await clients.s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey(app, stage),
        Body: sealed,
        ContentType: 'application/json',
      }),
    )
  },

  async currentVersion({ app, stage }) {
    const bucket = await readStateBucket(clients)
    let answer
    try {
      answer = await clients.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey(app, stage) }))
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
    const version = answer.VersionId
    // S3 reports the literal "null" for an object in an unversioned bucket.
    return typeof version === 'string' && version !== 'null' ? version : null
  },

  async versions({ app, stage }) {
    const bucket = await readStateBucket(clients)
    const key = objectKey(app, stage)
    const found: StoredVersion[] = []
    let keyMarker: string | undefined
    let versionIdMarker: string | undefined

    do {
      const answer = await clients.s3.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          // A prefix, so anything sharing this leading path comes back too and
          // is dropped below. Only the exact object is this stage's.
          Prefix: key,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
        }),
      )
      const collect = (entries: any[] | undefined, type: StoredVersion['type']) => {
        for (const entry of entries ?? []) {
          if (entry.Key !== key || typeof entry.VersionId !== 'string') continue
          found.push({
            versionId: entry.VersionId,
            type,
            lastModified: entry.LastModified ?? null,
            size: type === 'version' ? (entry.Size ?? null) : null,
            storageClass: type === 'version' ? (entry.StorageClass ?? null) : null,
          })
        }
      }
      collect(answer.Versions, 'version')
      collect(answer.DeleteMarkers, 'delete marker')
      keyMarker = answer.IsTruncated ? answer.NextKeyMarker : undefined
      versionIdMarker = answer.IsTruncated ? answer.NextVersionIdMarker : undefined
    } while (keyMarker || versionIdMarker)

    return found.sort((left, right) => (right.lastModified?.getTime() ?? 0) - (left.lastModified?.getTime() ?? 0))
  },

  async passphrase({ app, stage }) {
    const name = `/sst/passphrase/${app}/${stage}`
    let answer
    try {
      answer = await clients.ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))
    } catch (error) {
      if (isNotFound(error)) throw new EnvError(`${name} does not exist, so this store cannot be decrypted`)
      throw error
    }
    return Buffer.from(answer.Parameter?.Value ?? '', 'base64')
  },

  state: {
    readLegacyCheckpoint: ({ app, stage }) => readObject(clients, `app/${app}/${stage}.json`),
    readCheckpoint: ({ app, stage }) => readObject(clients, checkpointKey(app, stage)),

    async writeCheckpoint({ app, stage, checkpoint }) {
      const bucket = await readStateBucket(clients)
      await clients.s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: checkpointKey(app, stage),
          Body: checkpoint,
          ContentType: 'application/json',
        }),
      )
    },

    async readLock({ app, stage }) {
      const held = await lockFiles(clients, app, stage)
      if (!held.length) return null
      if (held.length > 1)
        throw new EnvError(`${app}/${stage} has ${held.length} locks; inspect the bucket before dropping any`)
      return readObject(clients, held[0]!)
    },

    async removeLock({ app, stage }) {
      const bucket = await readStateBucket(clients)
      for (const key of await lockFiles(clients, app, stage)) {
        await clients.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
      }
    },
  },
})
