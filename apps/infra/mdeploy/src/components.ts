import type { Cloud } from 'mstage/config'
import type { Intent } from './deploy.ts'
import { runnerFleetFrom } from './stack-env.ts'
import { runnerPolicyBatches } from '../stack/runners.ts'
import { runnerLabelValue } from '../stack/providers/gcp/runners.ts'

export type Components = 'api+runner' | 'api' | 'runner'

/** Shared by CLI and adapters: unsupported scopes must never become full deployments. */
export const deploymentComponents = ({
  value = 'api+runner',
  intent = 'deploy',
}: {
  value?: unknown
  home: Cloud
  intent?: Intent
}): Components => {
  if (value !== 'api+runner' && value !== 'api' && value !== 'runner')
    throw new Error('--components must be api+runner, api, or runner')
  if (value !== 'api+runner') {
    if (intent !== 'deploy' && intent !== 'diff')
      throw new Error('--components api or runner supports deploy and --diff only')
  }
  return value
}

export type DeployedResource = {
  urn: string
  type: string
  protect?: boolean
  delete?: boolean
  id?: string
  inputs?: {
    tags?: Record<string, string>
    type?: string
    encrypted?: boolean
    instanceId?: string
    volumeId?: string
    labels?: Record<string, string>
    instanceFilter?: {
      all?: boolean
      inclusionLabels?: { labels: Record<string, string> }[]
      exclusionLabels?: unknown[]
      inventories?: unknown[]
    }
  }
}

const API = 'gcp:cloudrunv2/service:Service'
const POLICY = 'gcp:osconfig/osPolicyAssignment:OsPolicyAssignment'
const INSTANCE = 'gcp:compute/instance:Instance'
const labelsKey = (labels: Record<string, string> = {}) => JSON.stringify(Object.entries(labels).sort())

/** Require an existing workload; permission patterns also cover grants first declared by this update. */
export const componentTargets = ({
  components,
  home = 'gcp',
  app,
  stage,
  resources,
  environment,
}: {
  components: Exclude<Components, 'api+runner'>
  home?: Cloud
  app: string
  stage: string
  resources: DeployedResource[]
  environment: NodeJS.ProcessEnv
}): string[] => {
  const prefix = `urn:pulumi:${stage}::${app}::`
  const existing = (type: string, name: string) =>
    resources.find(
      (resource) => !resource.delete && resource.type === type && resource.urn === `${prefix}${type}::${name}`,
    )
  const fullDeployment = () =>
    new Error(
      `${components} resources or fleet do not match the existing stage; run a full --components api+runner deployment first`,
    )
  if (home === 'aws') {
    if (components === 'api') {
      const service = existing('aws:ecs/service:Service', 'ApiService')
      const task = existing('aws:ecs/taskDefinition:TaskDefinition', 'ApiTask')
      if (!service || !task) throw fullDeployment()
      return [
        service.urn,
        task.urn,
        `${prefix}aws:iam/rolePolicy:RolePolicy::ApiExecutionSecrets`,
        `${prefix}aws:iam/rolePolicy:RolePolicy::ApiCapability*`,
      ]
    }
    if (components !== 'runner') throw new Error(`Unsupported deployment component: ${components}`)
    const fleet = runnerFleetFrom({ environment, app, stage })
    const instanceType = 'aws:ec2/instance:Instance'
    const instances = resources.filter(
      (resource) =>
        !resource.delete &&
        resource.type === instanceType &&
        resource.urn.startsWith(prefix) &&
        /^Runner(?:-runner-[0-9]+)?$/.test(resource.urn.split('::').at(-1)!),
    )
    if (instances.length !== fleet.length) throw fullDeployment()
    const targets: string[] = []
    for (const slot of fleet) {
      const instance = existing(instanceType, slot.resourceName)
      const disk = existing('aws:ebs/volume:Volume', slot.resourceName + 'DataDisk')
      const attachment = existing('aws:ec2/volumeAttachment:VolumeAttachment', slot.resourceName + 'DataAttachment')
      if (
        !instance?.id ||
        instance.inputs?.tags?.['boxlite:control-plane-runner-name'] !== slot.controlPlaneRunnerName ||
        !disk?.id ||
        disk.inputs?.type !== 'gp3' ||
        !disk.inputs.encrypted ||
        disk.inputs.tags?.['boxlite:app'] !== app ||
        disk.inputs.tags?.['boxlite:stage'] !== stage ||
        disk.inputs.tags?.['boxlite:role'] !== 'runner-data' ||
        disk.inputs.tags?.['boxlite:control-plane-runner-name'] !== slot.controlPlaneRunnerName ||
        attachment?.inputs?.instanceId !== instance.id ||
        attachment.inputs.volumeId !== disk.id
      )
        throw fullDeployment()
      for (const name of [
        slot.resourceName.replace(/^Runner/, 'CheckRunnerHealth'),
        slot.resourceName.replace(/^Runner/, 'UpgradeRunnerBinary'),
      ]) {
        const command = existing('command:local:Command', name)
        if (!command) throw fullDeployment()
        targets.push(command.urn)
      }
    }
    return [
      ...targets,
      `${prefix}aws:iam/rolePolicy:RolePolicy::RunnerArtifactS3Policy`,
      `${prefix}aws:iam/rolePolicy:RolePolicy::RunnerCheckpoints`,
    ]
  }
  switch (components) {
    case 'api': {
      const api = existing(API, 'Api')
      if (!api) throw fullDeployment()
      return [api.urn, `${prefix}gcp:secretmanager/secretIamMember:SecretIamMember::ApiSecretAccess-*`]
    }
    case 'runner': {
      const fleet = runnerFleetFrom({ environment, app, stage })
      const instances = resources.filter(
        (resource) =>
          !resource.delete &&
          resource.type === INSTANCE &&
          resource.urn.startsWith(`${prefix}${INSTANCE}::`) &&
          /^Runner(?:-runner-[0-9]+)?$/.test(resource.urn.split('::').at(-1)!),
      )
      if (instances.length !== fleet.length) throw fullDeployment()
      for (const slot of fleet) {
        const instance = existing(INSTANCE, slot.resourceName)
        if (
          !instance ||
          labelsKey(instance.inputs?.labels) !==
            labelsKey({ 'boxlite-runner': runnerLabelValue(slot.controlPlaneRunnerName), 'boxlite-stage': stage })
        )
          throw fullDeployment()
      }
      const targets = runnerPolicyBatches({ app, stage }, fleet).map((batch) => {
        const policy = existing(POLICY, batch.resourceName)
        const filter = policy?.inputs?.instanceFilter
        const expected = batch.hosts
          .map((slot) =>
            labelsKey({ 'boxlite-runner': runnerLabelValue(slot.controlPlaneRunnerName), 'boxlite-stage': stage }),
          )
          .sort()
        const recorded = filter?.inclusionLabels?.map(({ labels }) => labelsKey(labels)).sort()
        if (
          !policy ||
          filter?.all ||
          filter?.exclusionLabels?.length ||
          filter?.inventories?.length ||
          JSON.stringify(recorded) !== JSON.stringify(expected)
        )
          throw fullDeployment()
        return policy.urn
      })
      // A release-to-build transition needs this grant even when it was absent from the old state.
      return [...targets, `${prefix}gcp:storage/bucketIAMMember:BucketIAMMember::RunnerArtifactsRead*`]
    }
    default: {
      const unsupported: never = components
      throw new Error(`Unsupported deployment component: ${unsupported}`)
    }
  }
}
