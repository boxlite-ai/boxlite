import { readStackEnvironment } from '../src/stack-env.ts'
import { runnerArtifactsBucket, resolveRunnerBinary } from '../stack/runner-binary.ts'
import { installGlobals, PulumiProgramError, type PulumiModules, type ProgramOutputs } from './program.ts'
import { workloadSecretPath } from '../stack/providers/aws/secret-names.ts'
import { awsResourceDefaults } from './aws-defaults.ts'
import type { deployStack } from '../stack/index.ts'

type AwsModules = PulumiModules & {
  aws: {
    getCallerIdentity: (input: object) => Promise<{ accountId: string }>
  }
  pulumi: PulumiModules['pulumi'] & {
    runtime: { registerStackTransformation: (transform: ReturnType<typeof awsResourceDefaults>) => void }
  }
}

const PACKAGES = ['@pulumi/pulumi', '@pulumi/aws', '@pulumi/random', '@pulumi/cloudflare', '@pulumi/command']
const loadAwsModules = async (): Promise<AwsModules> => {
  try {
    const [pulumi, aws, random, cloudflare, command] = await Promise.all(PACKAGES.map((name) => import(name)))
    return { pulumi, aws, random, cloudflare, command } as AwsModules
  } catch (error) {
    throw new PulumiProgramError(`An AWS stage needs ${PACKAGES.join(', ')} in apps/infra: ${(error as Error).message}`)
  }
}

/** Native AWS resources use the same stage inputs and provider contracts as GCP. */
export const awsProgram =
  ({
    app,
    stage,
    region,
    stateBucket,
    protectedStage = false,
    environment,
    cwd,
    loadModules = loadAwsModules,
    deployStackWith,
  }: {
    app: string
    stage: string
    region: string
    stateBucket: string
    protectedStage?: boolean
    environment: NodeJS.ProcessEnv
    cwd: string
    loadModules?: () => Promise<AwsModules>
    deployStackWith?: typeof deployStack
  }) =>
  async (): Promise<ProgramOutputs> => {
    const modules = await loadModules()
    installGlobals({ modules, app, stage })
    Object.assign(globalThis, { $cli: { paths: { root: cwd } } })
    const { accountId } = await modules.aws.getCallerIdentity({})
    modules.pulumi.runtime.registerStackTransformation(awsResourceDefaults({ app, stage, accountId, protectedStage }))

    const { loadDeployConfig } = await import('../src/config.ts')
    const { loadConfig: loadStageConfig } = await import('mstage/config')
    const { deployStack: realDeployStack } = await import('../stack/index.ts')
    const { awsStackProviders } = await import('../stack/providers/aws/index.ts')
    const config = loadDeployConfig({ cwd, stage })
    const stageConfig = loadStageConfig({ cwd })
    const values = readStackEnvironment({
      environment,
      declaration: { groups: stageConfig.envSelectGroup, optional: stageConfig.envOptional, where: stageConfig.path },
      app,
      stage,
      region,
      home: 'aws',
    })
    const path = workloadSecretPath(app, stage)
    const secretPrefix = `arn:aws:secretsmanager:${region}:${accountId}:secret:${path}`
    const parameterPrefix = `arn:aws:ssm:${region}:${accountId}:parameter/${path}`
    const requireStageSecret = (key: string, ref: string, consumer: 'ecs' | 'host') => {
      if (
        consumer === 'ecs' &&
        ref.startsWith(parameterPrefix) &&
        /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(ref.slice(parameterPrefix.length))
      )
        return
      const [name, ...selectors] = ref.slice(secretPrefix.length).split(':')
      if (
        ref.startsWith(secretPrefix) &&
        name &&
        /^[A-Za-z0-9_+=.@-]+(?:\/[A-Za-z0-9_+=.@-]+)*$/.test(name) &&
        (consumer === 'ecs' || selectors.length === 0)
      )
        return
      const kind = consumer === 'host' ? 'a full Secrets Manager secret ARN' : 'a workload secret'
      throw new PulumiProgramError(
        `${key} must reference ${kind} authorized for this AWS account, region and stage; see docs/aws/deployment.md`,
      )
    }
    for (const group of [values.apiSecrets, values.proxySecrets, values.collectorSecrets]) {
      for (const [key, ref] of Object.entries(group)) requireStageSecret(key, ref, 'ecs')
    }
    for (const [key, ref] of Object.entries(values.runnerSecrets)) requireStageSecret(key, ref, 'host')
    if (values.managedClickHouse) {
      requireStageSecret('CLICKHOUSE_WRITER_PASSWORD_SECRET_ARN', values.managedClickHouse.writerSecretArn, 'host')
      requireStageSecret('CLICKHOUSE_READER_PASSWORD_SECRET_ARN', values.managedClickHouse.readerSecretArn, 'host')
    }
    const artifactsBucket = runnerArtifactsBucket({ app, stage, accountId })
    const runnerBinary = resolveRunnerBinary({
      environment,
      configRoot: config.root,
      staging: { cloud: 'aws', bucket: artifactsBucket },
    })
    return {
      ...(deployStackWith ?? realDeployStack)({
        providers: awsStackProviders({
          stateBucket,
          stage,
          region,
          accountId,
          artifactsBucket,
          volumePrefix: config.storage.volumePrefix,
          zoneId: values.dnsZoneId,
          domain: values.domain,
          dashboardDomain: values.dashboardDomain,
          managedClickHouse: values.managedClickHouse,
          otelOpenapiEnabled: values.otelOpenapiEnabled,
        }),
        config,
        inputs: {
          clickHouseRetentionHours: values.clickHouseRetentionHours,
          stage,
          tag: values.tag,
          domain: values.domain,
          proxyDomain: values.proxyDomain,
          proxyProtocol: values.proxyProtocol,
          proxyTemplateUrl: values.proxyTemplateUrl,
          internetEgress: true,
          senderDomain: values.senderDomain,
          userDomain: values.userDomain,
          runnerBinary,
          runnerFleet: values.runnerFleet,
          filestoreProjects: values.filestoreProjects,
          apiEnvironment: values.apiEnvironment,
          apiSecrets: values.apiSecrets,
          proxyEnvironment: values.proxyEnvironment,
          proxySecrets: values.proxySecrets,
          collectorEnvironment: values.collectorEnvironment,
          collectorSecrets: values.collectorSecrets,
          runnerEnvironment: values.runnerEnvironment,
          runnerSecrets: values.runnerSecrets,
        },
      }),
    }
  }
