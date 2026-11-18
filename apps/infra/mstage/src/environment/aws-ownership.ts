import { pulumiCheckpointKey } from './pulumi-state.ts'
import { randomUUID, createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { GetRoleCommand, GetRolePolicyCommand } from '@aws-sdk/client-iam'

type Sender = { send: (command: any) => Promise<any> }
export type AwsOwner = {
  version: 1
  app: string
  phase: 'legacy' | 'adopting' | 'native'
  sourceDigests: Record<string, string>
  nativeUpdateStarted: boolean
  nativeCheckpointDigest?: string | null
}
type Scope = { app: string; stage: string }
export type OwnershipAction = 'native' | 'legacy' | 'migration'
export type OwnershipContext = { signal: AbortSignal; markNativeUpdateStarted: () => Promise<void> }
export type AwsOwnership = {
  inspect: (scope: Scope) => Promise<AwsOwner | null>
  run: <T>(scope: Scope & { action: OwnershipAction }, work: (context: OwnershipContext) => Promise<T>) => Promise<T>
  transition: (
    scope: Scope & {
      action: 'begin' | 'cutover' | 'rollback' | 'unlock'
      sourceDigests?: Record<string, string>
      confirmed: boolean
      validate?: (signal: AbortSignal) => Promise<void>
    },
  ) => Promise<void>
}

const missing = (error: any) => ['NoSuchKey', 'NotFound', 'NoSuchEntity', 'NoSuchEntityException'].includes(error?.name)
const validate = ({ app, stage }: Scope) => {
  if (![app, stage].every((value) => /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(value))) {
    throw new Error('AWS ownership requires safe app and stage names')
  }
}
const parseOwner = (value: any): AwsOwner => {
  if (
    value?.version !== 1 ||
    !['legacy', 'adopting', 'native'].includes(value.phase) ||
    typeof value.app !== 'string' ||
    typeof value.nativeUpdateStarted !== 'boolean' ||
    (value.nativeCheckpointDigest != null &&
      (typeof value.nativeCheckpointDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.nativeCheckpointDigest))) ||
    !value.sourceDigests ||
    typeof value.sourceDigests !== 'object' ||
    Array.isArray(value.sourceDigests) ||
    Object.values(value.sourceDigests).some((digest) => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))
  ) {
    throw new Error('AWS ownership record is invalid; inspect the state bucket')
  }
  return value
}

/** Historical workflows cannot read this guard, so their role must be fenced in IAM first. */
export const assertLegacyRoleFenced = async (iam: Sender, stage: string): Promise<void> => {
  const RoleName = `boxlite-${stage}-github-deploy`
  try {
    await iam.send(new GetRoleCommand({ RoleName }))
  } catch (error) {
    if (missing(error)) return
    throw error
  }
  let response
  try {
    response = await iam.send(new GetRolePolicyCommand({ RoleName, PolicyName: 'BoxLiteLegacyDeploymentFence' }))
  } catch (error) {
    throw new Error(
      `Legacy role ${RoleName} is not fenced; a separate administrator must install the unconditional Deny-all policy`,
      { cause: error },
    )
  }
  let policy
  try {
    policy =
      typeof response.PolicyDocument === 'string'
        ? JSON.parse(decodeURIComponent(response.PolicyDocument))
        : response.PolicyDocument
  } catch {
    throw new Error('Legacy role fence is not valid policy JSON')
  }
  const statements = Array.isArray(policy?.Statement) ? policy.Statement : [policy?.Statement]
  const all = (value: unknown) => value === '*' || (Array.isArray(value) && value.includes('*'))
  if (
    !statements.some(
      (statement: any) =>
        statement?.Effect === 'Deny' &&
        all(statement.Action) &&
        all(statement.Resource) &&
        !statement.Condition &&
        !statement.NotAction &&
        !statement.NotResource,
    )
  ) {
    throw new Error('Legacy deployment fence must deny all actions and resources without conditions')
  }
}

/**
 * One region/stage owner and lease in the existing state bucket.
 * Expired leases are never stolen automatically: a lost supervisor may leave cloud work running.
 */
export const awsOwnership = ({
  s3,
  iam,
  stateBucket,
  now = Date.now,
}: {
  s3: Sender
  iam: Sender
  stateBucket: () => Promise<string>
  now?: () => number
}): AwsOwnership => {
  const keys = (scope: Scope) => {
    validate(scope)
    return { owner: `migration/aws/${scope.stage}/owner.json`, lease: `migration/aws/${scope.stage}/lease.json` }
  }
  const read = async (Bucket: string, Key: string) => {
    let response
    try {
      response = await s3.send(new GetObjectCommand({ Bucket, Key }))
    } catch (error) {
      if (missing(error)) return null
      throw error
    }
    if (!response.ETag) throw new Error('S3 ownership read returned no ETag')
    const raw = await response.Body.transformToString()
    return { value: JSON.parse(raw), raw, etag: response.ETag as string }
  }
  const digestOf = (raw: string) => createHash('sha256').update(raw).digest('hex')
  const snapshotKey = (stage: string, digest: string) => `migration/aws/${stage}/native-checkpoints/${digest}.json`
  const saveCheckpoint = async (Bucket: string, scope: Scope) => {
    const checkpoint = await read(Bucket, pulumiCheckpointKey(scope.app, scope.stage))
    if (!checkpoint) return null
    const digest = digestOf(checkpoint.raw)
    const Key = snapshotKey(scope.stage, digest)
    try {
      await s3.send(
        new PutObjectCommand({ Bucket, Key, Body: checkpoint.raw, ContentType: 'application/json', IfNoneMatch: '*' }),
      )
    } catch (error: any) {
      if (error?.name !== 'PreconditionFailed' || (await read(Bucket, Key))?.raw !== checkpoint.raw) throw error
    }
    return digest
  }
  const restoreCheckpoint = async (
    Bucket: string,
    scope: Scope,
    digest: string | null | undefined,
    signal: AbortSignal,
  ) => {
    if (digest === undefined)
      throw new Error(
        'Adoption has no pre-import checkpoint record; reconcile the saved backup before returning ownership',
      )
    const Key = pulumiCheckpointKey(scope.app, scope.stage)
    const current = await read(Bucket, Key)
    if (digest === null) {
      signal.throwIfAborted()
      if (current) await s3.send(new DeleteObjectCommand({ Bucket, Key, IfMatch: current.etag }))
      return
    }
    if (current && digestOf(current.raw) === digest) return
    const saved = await read(Bucket, snapshotKey(scope.stage, digest))
    if (!saved || digestOf(saved.raw) !== digest) throw new Error('Pre-import checkpoint backup is missing or changed')
    signal.throwIfAborted()
    await s3.send(
      new PutObjectCommand({
        Bucket,
        Key,
        Body: saved.raw,
        ContentType: 'application/json',
        ...(current ? { IfMatch: current.etag } : { IfNoneMatch: '*' }),
      }),
    )
  }
  const writeOwner = async (Bucket: string, Key: string, owner: AwsOwner, etag?: string) => {
    const result = await s3.send(
      new PutObjectCommand({
        Bucket,
        Key,
        Body: JSON.stringify(owner),
        ContentType: 'application/json',
        ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }),
      }),
    )
    if (!result.ETag) throw new Error('S3 ownership write returned no ETag; inspect before retrying')
    return result.ETag as string
  }
  const withLease = async <T>(
    scope: Scope,
    work: (bucket: string, key: string, signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const key = keys(scope)
    const Bucket = await stateBucket()
    const token = randomUUID()
    const leaseBody = () => JSON.stringify({ token, app: scope.app, expiresAt: now() + 150_000 })
    let lease: { ETag?: string }
    try {
      lease = await s3.send(
        new PutObjectCommand({
          Bucket,
          Key: key.lease,
          Body: leaseBody(),
          ContentType: 'application/json',
          IfNoneMatch: '*',
        }),
      )
    } catch (error: any) {
      if (error?.name === 'PreconditionFailed')
        throw new Error(
          `AWS stage ${scope.stage} already has an ownership lease; inspect and settle outstanding work before aws:migrate unlock`,
          { cause: error },
        )
      throw error
    }
    if (!lease.ETag) throw new Error('S3 lease write returned no ETag; inspect before retrying')
    const controller = new AbortController()
    let renewing = Promise.resolve()
    const timer = setInterval(() => {
      renewing = renewing.then(async () => {
        if (controller.signal.aborted) return
        try {
          lease = await s3.send(
            new PutObjectCommand({
              Bucket,
              Key: key.lease,
              Body: leaseBody(),
              ContentType: 'application/json',
              IfMatch: lease.ETag,
            }),
          )
          if (!lease.ETag) throw new Error('S3 lease renewal returned no ETag')
        } catch (error) {
          controller.abort(error)
        }
      })
    }, 30_000)
    timer.unref()
    try {
      const result = await work(Bucket, key.owner, controller.signal)
      clearInterval(timer)
      await renewing
      controller.signal.throwIfAborted()
      await s3.send(new DeleteObjectCommand({ Bucket, Key: key.lease, IfMatch: lease.ETag }))
      return result
    } finally {
      clearInterval(timer)
      await renewing
      // Failures retain the lease until the operator reconciles outstanding work.
    }
  }
  return {
    async inspect(scope) {
      const record = await read(await stateBucket(), keys(scope).owner)
      return record ? parseOwner(record.value) : null
    },
    async run(scope, work) {
      return withLease(scope, async (bucket, key, signal) => {
        const record = await read(bucket, key)
        let owner = record ? parseOwner(record.value) : null
        let etag = record?.etag
        if (owner && owner.app !== scope.app && scope.action !== 'legacy')
          throw new Error('Stage is owned by another native app')
        if (scope.action === 'legacy') {
          if (owner && owner.phase !== 'legacy')
            throw new Error(`Legacy deployment is blocked while ownership is ${owner.phase}`)
        } else {
          await assertLegacyRoleFenced(iam, scope.stage)
          signal.throwIfAborted()
          if (scope.action === 'migration') {
            if (owner?.phase !== 'adopting') throw new Error('Migration commands require adopting ownership')
          } else {
            if (owner?.phase === 'adopting' || owner?.phase === 'legacy')
              throw new Error('Regular native deployment requires explicit native cutover')
            const sourceDigests: Record<string, string> = {}
            for (const source of new Set([scope.app, 'boxlite'])) {
              const legacy = await read(bucket, `app/${source}/${scope.stage}.json`)
              if (legacy) sourceDigests[source] = createHash('sha256').update(legacy.raw).digest('hex')
            }
            if (!owner && Object.keys(sourceDigests).length)
              throw new Error('Existing SST state requires explicit adoption and native cutover')
            if (owner && !isDeepStrictEqual(owner.sourceDigests, sourceDigests))
              throw new Error('Frozen legacy checkpoints changed; refusing native mutation')
            if (!owner) {
              signal.throwIfAborted()
              owner = { version: 1, app: scope.app, phase: 'native', sourceDigests: {}, nativeUpdateStarted: false }
              etag = await writeOwner(bucket, key, owner)
            }
          }
        }
        signal.throwIfAborted()
        return work({
          signal,
          markNativeUpdateStarted: async () => {
            signal.throwIfAborted()
            if (scope.action !== 'native' || owner?.phase !== 'native')
              throw new Error('Only the native owner can submit an update')
            if (!owner.nativeUpdateStarted) {
              owner = { ...owner, nativeUpdateStarted: true }
              etag = await writeOwner(bucket, key, owner, etag)
            }
          },
        })
      })
    },
    async transition(scope) {
      if (!scope.confirmed) throw new Error('Ownership changes require --confirm after reviewing the migration runbook')
      const key = keys(scope)
      if (scope.action === 'unlock') {
        const bucket = await stateBucket()
        const lease = await read(bucket, key.lease)
        if (!lease) return
        if (typeof lease.value.expiresAt !== 'number' || lease.value.expiresAt >= now())
          throw new Error('Deployment lease has not expired')
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key.lease, IfMatch: lease.etag }))
        return
      }
      await withLease(scope, async (bucket, ownerKey, signal) => {
        const record = await read(bucket, ownerKey)
        const current = record ? parseOwner(record.value) : null
        if (current && current.app !== scope.app) throw new Error('Stage is owned by another native app')
        await scope.validate?.(signal)
        signal.throwIfAborted()
        if (scope.action === 'rollback') {
          if (current?.phase !== 'adopting' && current?.phase !== 'native')
            throw new Error('No migration is available to roll back')
          if (!Object.keys(current.sourceDigests).length)
            throw new Error('A fresh native stage has no legacy migration to roll back')
          if (current.nativeUpdateStarted)
            throw new Error('Native update has started; use forward repair instead of legacy rollback')
          await restoreCheckpoint(bucket, scope, current.nativeCheckpointDigest, signal)
          signal.throwIfAborted()
          await writeOwner(bucket, ownerKey, { ...current, phase: 'legacy' }, record!.etag)
          return
        }
        await assertLegacyRoleFenced(iam, scope.stage)
        signal.throwIfAborted()
        if (scope.action === 'begin') {
          if (current && current.phase !== 'legacy') throw new Error('Migration has already begun')
          const sourceDigests = scope.sourceDigests ?? {}
          const owner = parseOwner({
            version: 1,
            app: scope.app,
            phase: 'adopting',
            sourceDigests,
            nativeUpdateStarted: false,
          })
          if (!Object.keys(sourceDigests).length) throw new Error('Adoption requires frozen legacy checkpoint digests')
          owner.nativeCheckpointDigest = await saveCheckpoint(bucket, scope)
          signal.throwIfAborted()
          await writeOwner(bucket, ownerKey, owner, record?.etag)
          return
        }
        if (current?.phase !== 'adopting') throw new Error('Cutover requires adopting ownership')
        await writeOwner(bucket, ownerKey, { ...current, phase: 'native' }, record!.etag)
      })
    },
  }
}
