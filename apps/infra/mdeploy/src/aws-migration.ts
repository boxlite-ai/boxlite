import { createHash } from 'node:crypto'
import type { StoreBackend } from 'mstage/env'
import type { Intent } from './deploy.ts'

/** An acknowledgement is valid only for frozen source snapshots and an imported native checkpoint. */
export const assertAwsMigrationReady = async ({
  backend,
  app,
  stage,
  intent,
  environment,
}: {
  backend: StoreBackend
  app: string
  stage: string
  intent: Intent
  environment: NodeJS.ProcessEnv
}): Promise<void> => {
  if (intent === 'diff') return
  // The incumbent checked-in SST program used boxlite; the new stage declaration may use another app.
  const snapshots = Object.entries(await awsLegacyCheckpointDigests({ backend, app, stage })).map(([app, digest]) => ({
    app,
    digest,
  }))
  if (!snapshots.length) return
  let acknowledged: unknown
  try {
    acknowledged = JSON.parse(environment.AWS_PULUMI_MIGRATION ?? '{}')
  } catch {
    throw new Error('AWS_PULUMI_MIGRATION must be a JSON map of SST app names to checkpoint SHA-256 digests')
  }
  if (
    !acknowledged ||
    typeof acknowledged !== 'object' ||
    Array.isArray(acknowledged) ||
    snapshots.some((snapshot) => (acknowledged as Record<string, unknown>)[snapshot.app] !== snapshot.digest)
  ) {
    throw new Error(
      'Existing SST state requires a reviewed native import and AWS_PULUMI_MIGRATION acknowledgements; see docs/aws/migration.md',
    )
  }
  const native = await backend.state.readCheckpoint({ app, stage })
  let checkpoint: any
  try {
    checkpoint = native && JSON.parse(native.toString('utf8'))
  } catch {
    throw new Error('The imported Pulumi checkpoint is not valid JSON')
  }
  const resources = checkpoint?.checkpoint?.latest?.resources
  if (
    !Array.isArray(resources) ||
    !resources.some(
      (resource: any) => resource.custom && typeof resource.type === 'string' && !resource.type.startsWith('pulumi:'),
    )
  ) {
    throw new Error('Existing SST resources must be imported into the native Pulumi checkpoint before applying')
  }
  if (
    !environment.AWS_VOLUME_ACCESS_ROLE_NAME ||
    !/^[A-Za-z0-9+=,.@_-]{1,64}$/.test(environment.AWS_VOLUME_ACCESS_ROLE_NAME)
  ) {
    throw new Error('An SST migration must adopt the existing AWS_VOLUME_ACCESS_ROLE_NAME')
  }
  if (!environment.AWS_DATABASE_PASSWORD_SECRET_ARN || !environment.AWS_CACHE_PASSWORD_SECRET_ARN) {
    throw new Error('An SST migration must adopt the existing database and cache password secret ARNs')
  }
}

/** Raw checkpoint bytes are frozen evidence, not a parsed/reformatted approximation. */
export const awsLegacyCheckpointDigests = async ({
  backend,
  app,
  stage,
}: {
  backend: StoreBackend
  app: string
  stage: string
}): Promise<Record<string, string>> => {
  if (!backend.state.readLegacyCheckpoint) throw new Error('The AWS backend cannot inspect the SST migration source')
  const result: Record<string, string> = {}
  for (const source of new Set([app, 'boxlite'])) {
    const checkpoint = await backend.state.readLegacyCheckpoint({ app: source, stage })
    if (checkpoint) result[source] = createHash('sha256').update(checkpoint).digest('hex')
  }
  return result
}
