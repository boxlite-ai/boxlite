import type { Cloud } from 'mstage/config'
import type { Components, DeployedResource } from './components.ts'

const serviceNames = {
  api: 'Api',
  proxy: 'Proxy',
  'otel-collector': 'OtelCollector',
  'registry-proxy': 'RegistryProxy',
}
const secretSignature = '4dabf18193072939515e22adb298388d'

// Automation exports secrets as plaintext JSON inside a Pulumi secret envelope.
// Read only the fields used for release selection and never include the raw state in diagnostics.
const unpack = (value: any): any => {
  if (value?.[secretSignature] !== '1b47061264138c4ac30d75fd1eb44270') return value
  if (typeof value.plaintext === 'string') {
    try {
      return JSON.parse(value.plaintext)
    } catch {
      return undefined
    }
  }
  return value.value
}

export const deployedReleases = ({
  components,
  home,
  app,
  stage,
  resources,
}: {
  components: Exclude<Components, 'api+runner'>
  home: Cloud
  app: string
  stage: string
  resources: DeployedResource[]
}): { retainedImages: Record<string, string>; releaseEnvironment: NodeJS.ProcessEnv } => {
  const prefix = `urn:pulumi:${stage}::${app}::`
  const active = resources.filter((r) => !r.delete && r.urn.startsWith(prefix + r.type + '::'))
  const retainedImages: Record<string, string> = {}
  const releaseEnvironment: NodeJS.ProcessEnv = {}
  for (const [component, name] of Object.entries(serviceNames)) {
    if (components === 'api' && component === 'api') continue
    const aws = home === 'aws'
    const kube = !aws && component === 'proxy'
    const type = aws
      ? 'aws:ecs/taskDefinition:TaskDefinition'
      : kube
        ? 'kubernetes:apps/v1:Deployment'
        : 'gcp:cloudrunv2/service:Service'
    const urn = prefix + type + '::' + name + (aws ? 'Task' : kube ? 'Deployment' : '')
    const found = active.filter((r) => r.urn === urn)
    let image: unknown
    try {
      const inputs = unpack(found.length === 1 ? found[0]?.inputs : undefined)
      const containers = aws
        ? JSON.parse(unpack(inputs?.containerDefinitions))
        : kube
          ? unpack(inputs?.spec?.template?.spec?.containers)
          : unpack(inputs?.template?.containers)
      if (Array.isArray(containers) && containers.length === 1) {
        const container = unpack(containers[0])
        if (component === 'api') {
          const env = unpack(aws ? container.environment : container.envs) ?? []
          const entry = env.find((item: any) => item.name === 'CI_SCHEDULER_GENERATION')
          const generation = unpack(entry?.value)
          if (entry && (typeof generation !== 'string' || !/^[1-9][0-9]*$/.test(generation))) throw new Error()
          releaseEnvironment.CI_SCHEDULER_GENERATION = generation
          releaseEnvironment.GITHUB_RUN_ID = undefined
        }
        image = unpack(container.image)
      }
    } catch {
      // Malformed container definitions can contain credentials and must not be logged.
    }
    if (typeof image !== 'string' || !image.trim())
      throw new Error(`Cannot retain the deployed image for ${name}; use a full deployment`)
    retainedImages[component] = image
  }
  if (components === 'api') {
    const aws = home === 'aws'
    const type = aws ? 'command:local:Command' : 'gcp:osconfig/osPolicyAssignment:OsPolicyAssignment'
    const pattern = aws ? /^UpgradeRunnerBinary(?:-runner-[0-9]+)?$/ : /^RunnerBinary(?:Fleet)?$/
    const runners = active.filter((r) => r.type === type && pattern.test(r.urn.slice((prefix + type + '::').length)))
    const identities = new Set(
      runners.map((runner) => {
        const inputs = unpack(runner.inputs)
        return aws
          ? unpack(unpack(inputs?.environment)?.RUNNER_UPGRADE_IDENTITY)
          : /^BoxLite runner binary (.+)$/.exec(inputs?.description)?.[1]
      }),
    )
    const [identity] = identities
    const match = typeof identity === 'string' && /^(\d+\.\d+\.\d+)(?:\+([0-9a-f]{40}))?$/.exec(identity)
    if (identities.size !== 1 || !match)
      throw new Error('Cannot establish a single deployed Runner release; use a full deployment')
    releaseEnvironment.VERSION = match[1]
    releaseEnvironment.RUNNER_ARTIFACT_SOURCE = match[2] ? 'build' : 'release'
    if (match[2]) releaseEnvironment.RUNNER_ARTIFACT_REF = match[2]
  }
  return { retainedImages, releaseEnvironment }
}
