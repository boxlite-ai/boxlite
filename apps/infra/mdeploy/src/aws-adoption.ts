import { isDeepStrictEqual } from 'node:util'
import type { StoreBackend } from 'mstage/env'
import type { EngineEvent } from '@pulumi/pulumi/automation/index.js'
import { assertAwsMigrationReady, awsLegacyCheckpointDigests } from './aws-migration.ts'

/** A prepared native export, with reviewed URN/provider mappings and re-encrypted secrets. */
export const nativeImportDocument = (raw: string, app: string, stage: string): { version: number; deployment: any } => {
  const document = JSON.parse(raw)
  const resources = document?.deployment?.resources
  const prefix = `urn:pulumi:${stage}::${app}::`
  if (document.version !== 3 || !Array.isArray(resources) || !resources.length)
    throw new Error('Expected a nonempty native Pulumi version-3 export')
  const urns = new Set<string>()
  for (const resource of resources) {
    if (
      typeof resource.type !== 'string' ||
      typeof resource.urn !== 'string' ||
      resource.urn.split('::').at(-2)?.split('$').at(-1) !== resource.type ||
      !resource.urn.startsWith(prefix) ||
      urns.has(resource.urn) ||
      resource.delete ||
      (resource.custom && !resource.id)
    )
      throw new Error('Native import has foreign, duplicate or incomplete resource identities')
    const references = [
      resource.parent,
      resource.provider?.split('::').slice(0, -1).join('::'),
      ...(resource.dependencies ?? []),
      ...Object.values(resource.propertyDependencies ?? {}).flat(),
    ]
    if (references.some((urn: any) => urn && (typeof urn !== 'string' || !urn.startsWith(prefix)))) {
      throw new Error('Native import contains foreign parent, provider or dependency references')
    }
    urns.add(resource.urn)
  }
  if (document.deployment.pending_operations?.length) throw new Error('Native import must have no pending operations')
  return document
}

const stateful = new Set([
  'aws:rds/instance:Instance',
  'aws:elasticache/replicationGroup:ReplicationGroup',
  'aws:ec2/instance:Instance',
  'aws:ebs/volume:Volume',
  'aws:s3/bucketV2:BucketV2',
])

/** Before cutover, every incumbent stateful physical object must already belong to native state. */
export const assertAwsAdoptionInventory = async ({
  backend,
  app,
  stage,
  environment,
}: {
  backend: StoreBackend
  app: string
  stage: string
  environment: NodeJS.ProcessEnv
}): Promise<void> => {
  await assertAwsMigrationReady({ backend, app, stage, environment, intent: 'deploy' })
  await assertAwsFrozenSources({ backend, app, stage })
  const digests = await awsLegacyCheckpointDigests({ backend, app, stage })
  const native = await backend.state.readCheckpoint({ app, stage })
  const imported = JSON.parse(native!.toString()).checkpoint?.latest?.resources ?? []
  const identities = new Set(
    imported.filter((resource: any) => resource.id).map((resource: any) => resource.type + ':' + resource.id),
  )
  for (const source of Object.keys(digests)) {
    const raw = await backend.state.readLegacyCheckpoint!({ app: source, stage })
    const resources = JSON.parse(raw!.toString()).checkpoint?.latest?.resources
    if (!Array.isArray(resources)) throw new Error('Legacy checkpoint has no resource inventory')
    for (const resource of resources) {
      if (stateful.has(resource.type) && resource.id && !identities.has(resource.type + ':' + resource.id)) {
        throw new Error(`Native import is missing incumbent ${resource.type}; review the physical-ID inventory`)
      }
    }
  }
}

export const adoptionPreview = () => {
  let complete = false
  const destructive = new Set<string>()
  return {
    onEvent(event: EngineEvent) {
      if (event.summaryEvent) complete = true
      const step = event.resourcePreEvent?.metadata
      // ECS task-definition revisions are stateless replacements during environment/image updates.
      if (
        step?.type === 'aws:ecs/taskDefinition:TaskDefinition' &&
        ['replace', 'create-replacement', 'delete-replaced'].includes(step.op)
      )
        return
      if (
        step &&
        ['delete', 'replace', 'create-replacement', 'delete-replaced', 'discard', 'discard-replaced'].includes(step.op)
      ) {
        destructive.add(step.urn)
      }
    },
    assertReady() {
      if (!complete) throw new Error('Migration preview returned no completion evidence')
      if (destructive.size)
        throw new Error('Migration preview would replace or delete resources: ' + [...destructive].sort().join(', '))
    },
  }
}

export const assertAwsFrozenSources = async ({
  backend,
  app,
  stage,
}: {
  backend: StoreBackend
  app: string
  stage: string
}): Promise<void> => {
  const owner = await backend.ownership?.inspect({ app, stage })
  const digests = await awsLegacyCheckpointDigests({ backend, app, stage })
  if (!owner || !isDeepStrictEqual(owner.sourceDigests, digests))
    throw new Error('Frozen legacy checkpoints changed after adoption began')
}
