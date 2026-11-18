import { readStackEnvironment } from '../src/stack-env.ts'
import { runnerArtifactsBucket, resolveRunnerBinary } from '../stack/runner-binary.ts'
import { installGlobals, PulumiProgramError, type PulumiModules, type ProgramOutputs } from './program.ts'
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
    retainedImages,
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
    retainedImages?: Record<string, string>
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
          existingDatabasePasswordRef: environment.AWS_DATABASE_PASSWORD_SECRET_ARN,
          existingCachePasswordRef: environment.AWS_CACHE_PASSWORD_SECRET_ARN,
          existingVolumeRoleName: environment.AWS_VOLUME_ACCESS_ROLE_NAME,
        }),
        config,
        inputs: {
          clickHouseRetentionHours: values.clickHouseRetentionHours,
          stage,
          tag: values.tag,
          retainedImages,
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
