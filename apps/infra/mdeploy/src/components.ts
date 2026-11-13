import type { Cloud } from 'mstage/config'
import type { Intent } from './deploy.ts'
import { runnerFleetFrom } from './stack-env.ts'
import { runnerPolicyBatches } from '../stack/runners.ts'
import { runnerLabelValue } from '../stack/providers/gcp/runners.ts'

export type Components = 'api+runner' | 'api' | 'runner'

/** Shared by CLI and adapters: unsupported scopes must never become full deployments. */
export const deploymentComponents = ({
  value = 'api+runner',
  home,
  intent = 'deploy',
}: {
  value?: unknown
  home: Cloud
  intent?: Intent
}): Components => {
  if (value !== 'api+runner' && value !== 'api' && value !== 'runner')
    throw new Error('--components must be api+runner, api, or runner')
  if (value !== 'api+runner') {
    if (home !== 'gcp')
      throw new Error('AWS/SST does not support independent API/Runner deployment; use --components api+runner')
    if (intent !== 'deploy' && intent !== 'diff')
      throw new Error('--components api or runner supports deploy and --diff only')
  }
  return value
}

export type DeployedResource = {
  urn: string
  type: string
  delete?: boolean
  inputs?: {
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
  app,
  stage,
  resources,
  environment,
}: {
  components: Exclude<Components, 'api+runner'>
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
  if (components === 'api') {
    const api = existing(API, 'Api')
    if (!api) throw fullDeployment()
    return [api.urn, `${prefix}gcp:secretmanager/secretIamMember:SecretIamMember::ApiSecretAccess-*`]
  }

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
