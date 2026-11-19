/** Pulumi drives both clouds; configuration and deployment state share the stage's own cloud. */

import type { EngineEvent } from '@pulumi/pulumi/automation/index.js'
import { gcpProgram, type ProgramOutputs } from '../pulumi/program.ts'
import { awsProgram } from '../pulumi/aws-program.ts'
import { publicHostsFor } from '../stack/api.ts'
import { userDomainFrom } from './stack-env.ts'
import {
  assertAuthorizationsConverge,
  authorizationsThroughGcloud,
  type LookupAuthorizations,
} from './dns-authorization.ts'
import { spawnWith } from './upgrade-runners.ts'
import type { Identity } from 'mstage/identity'
import type { Cloud, MstageConfig } from 'mstage/config'
import type { StoreBackend } from 'mstage/env'
import type { Scope } from 'mstage/scope'
import { windowFor } from './credential-window.ts'
import { PULUMI_GROUP, TEARDOWN_GROUPS, rolloutGroups } from './env.ts'
import type { DeployRequest, DeployTarget, Intent } from './deploy.ts'
import { componentTargets, deploymentComponents, type Components, type DeployedResource } from './components.ts'

/** What each intent is called while it runs, and which engine call performs it. */
const NARRATION: Record<Intent, string> = {
  deploy: 'deploying',
  diff: 'comparing',
  remove: 'removing',
  refresh: 'reconciling the state of',
}
type OperationOptions = {
  onOutput?: (output: string) => void
  target?: string[]
  targetDependents?: boolean
  onEvent?: (event: EngineEvent) => void
  refresh?: boolean
  signal?: AbortSignal
}
const ACT: Record<Intent, (stack: PulumiStack, options: OperationOptions) => Promise<unknown>> = {
  deploy: (stack, options) => stack.up(options),
  diff: (stack, options) => stack.preview(options),
  remove: (stack, options) => stack.destroy(options),
  /*
   * What an interrupted run leaves behind, and the only way to clear it.
   *
   * Pulumi records an operation before it starts one and clears it when it
   * finishes; a driver killed in between leaves the record, and every later
   * run then opens with `2 pending operations from previous deployment` over
   * resources it calls unknown. The engine's own advice is a refresh, and
   * until this existed the only way to take it was a script outside the
   * repository holding the backend URL and the passphrase by hand.
   */
  refresh: (stack, options) => stack.refresh(options),
}

/**
 * Pulumi's progress spinner, which a log file has no use for.
 *
 * The engine writes it for a terminal — the intent, then a dot per tick, with
 * no newline — and a workflow log has nothing to overwrite. Worse, this driver
 * splits what it is handed into lines, so each dot arrives as a line of its
 * own: of one dev apply's 1546 lines, 987 were a single `.` and 20 were
 * `@ updating....`, so 65% of the output said only that time was passing.
 *
 * The intent is one word or several — an apply writes `@ updating`, a preview
 * writes `@ previewing update` — so the words are matched as a group. A pattern
 * cut to the apply's single word let every preview line through.
 *
 * Dropped rather than collapsed into one line, because the resource lines
 * around them already carry the heartbeat: the engine re-emits `creating (7s)`,
 * `creating (16s)`, `created (25s)` as an apply proceeds, which says both that
 * it is alive and what it is waiting on.
 */
const PROGRESS = /^(@ [a-z]+(?: [a-z]+)*\.*|\.+)$/

export class PulumiDeployError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PulumiDeployError'
  }
}

/**
 * The passphrase Pulumi seals the state's secrets with.
 *
 * Kept in the stage's own store, like everything else a deploy needs, rather
 * than in a cloud key service: mstage already distributes per-stage secrets, and
 * a second mechanism for one value would be a second thing to bootstrap.
 */
const PASSPHRASE_KEY = 'PULUMI_CONFIG_PASSPHRASE'

const AUTOMATION = '@pulumi/pulumi/automation'

/** The part of the Automation API this uses, in the shape it already has. */
export type PulumiStack = {
  setAllConfig: (config: Record<string, { value: string; secret?: boolean }>) => Promise<void>
  up: (options: OperationOptions) => Promise<unknown>
  preview: (options: OperationOptions) => Promise<unknown>
  destroy: (options: OperationOptions) => Promise<unknown>
  refresh: (options: OperationOptions) => Promise<unknown>
  exportStack: () => Promise<{ deployment?: { resources?: DeployedResource[] } }>
}

export type StackFactory = (input: {
  projectName: string
  stackName: string
  program: () => Promise<ProgramOutputs>
  /** What the engine subprocess inherits: credentials, and the passphrase. */
  envVars: Record<string, string>
  /** `s3://<bucket>` or `gs://<bucket>` — the same bucket mstage keeps this stage's store in. */
  backendUrl: string
  selectOnly?: boolean
}) => Promise<PulumiStack>

/**
 * The real Automation API, loaded when a deployment runs.
 *
 * Structural above and lazy here for the reason mstage loads the Google SDKs
 * lazily (`mstage/src/home.ts:44-49`): an AWS-only repository should not have to
 * carry the packages, and a test should be able to drive this without them.
 */
export const createStack: StackFactory = async ({
  projectName,
  stackName,
  program,
  envVars,
  backendUrl,
  selectOnly,
}) => {
  let automation: any
  try {
    // A constant rather than a literal: see the note in `pulumi/program.ts`.
    automation = await import(AUTOMATION)
  } catch (error) {
    throw new PulumiDeployError(
      'A deployment needs @pulumi/pulumi installed in apps/infra, and the `pulumi` CLI on PATH — ' +
        'the Automation API does not bundle the engine, it spawns that binary. ' +
        `Install both, or pass a factory to pulumiDeploy. (${(error as Error).message})`,
    )
  }
  const stack = { stackName, projectName, program }
  const workspace = {
    ...(backendUrl.startsWith('s3://') && { pulumiCommand: await awsPulumiCommand(automation, envVars) }),
    envVars,
    projectSettings: { name: projectName, runtime: 'nodejs', backend: { url: backendUrl } },
  }
  return selectOnly
    ? automation.LocalWorkspace.selectStack(stack, workspace)
    : automation.LocalWorkspace.createOrSelectStack(stack, workspace)
}

// The SDK can prepare an update after the deadline and attaches its abort listener after spawn.
async function awsPulumiCommand(automation: any, envVars: Record<string, string>) {
  const cli = await automation.PulumiCommand.get({
    skipVersionCheck: Boolean(
      envVars.PULUMI_AUTOMATION_API_SKIP_VERSION_CHECK || process.env.PULUMI_AUTOMATION_API_SKIP_VERSION_CHECK,
    ),
  })
  return {
    command: cli.command,
    version: cli.version,
    run(
      args: string[],
      cwd: string,
      env: Record<string, string>,
      onOutput?: (line: string) => void,
      onError?: (line: string) => void,
      signal?: AbortSignal,
    ) {
      signal?.throwIfAborted()
      return cli.run(args, cwd, env, onOutput, onError, signal)
    },
  }
}

export type PulumiDeployInput = {
  intent?: Intent
  components?: Components
  config: Pick<MstageConfig, 'root'>
  scope: Scope
  /**
   * Cloud-neutral on purpose: this asks the two questions every identity
   * answers, and never for a credential. The GCP identity has nothing to hand
   * over — Application Default Credentials are a file the SDK re-reads — so a
   * driver that asked for a key triple could not be given one.
   */
  identity: Pick<Identity, 'assertUsableFor' | 'childEnvironment'>
  /** Where mstage keeps this stage's store, and where Pulumi keeps its state. */
  state: { bucket: string }
  /** The stage's configuration, handed to the program rather than exported. */
  stageEnvironment?: Record<string, string>
  log: (line: string) => void
  createStackWith?: StackFactory
  /**
   * Who answers what the project already holds for this stage's API host.
   *
   * Injected so the refusal can be exercised without a project: the default
   * shells out to `gcloud` with the credentials this deploy resolved.
   */
  lookupAuthorizations?: LookupAuthorizations
}

/** Nothing but strings reaches a subprocess; an unset variable is not an empty one. */
const definedOnly = (environment: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined))

export const pulumiDeploy = async ({
  intent = 'deploy',
  components = 'api+runner',
  config,
  scope,
  identity,
  state,
  stageEnvironment = {},
  log,
  createStackWith = createStack,
  lookupAuthorizations,
}: PulumiDeployInput): Promise<number> => {
  deploymentComponents({ value: components, home: scope.home, intent })
  /*
   * The project the stage declares, which is also what the Pulumi provider has
   * to be pointed at. Read from the one declaration rather than asked of the
   * credentials: mstage does not second-guess which tenant the resolved
   * credentials reach, and a GCP client cannot be built without a project
   * anyway (`mstage/src/config/load.ts`).
   */
  const project = scope.project
  if (scope.home === 'gcp' && !project) {
    throw new PulumiDeployError(
      `Stage "${scope.stage}" declares no project. A GCP stage declares it as project in mstage.config.json.`,
    )
  }
  // Nothing to check on GCP — Application Default Credentials refresh
  // themselves — but the AWS identity answers the same question, and a driver
  // that skipped it would be one place the two clouds differ for no reason.
  await identity.assertUsableFor(windowFor(intent))

  const { env: credentials, expiresAt } = await identity.childEnvironment()
  // The store last, so a stale export in this shell cannot shadow it: the point
  // of keeping configuration in one place is that it wins.
  const environment = definedOnly({
    ...credentials,
    ...stageEnvironment,
    ...(scope.home === 'aws' ? { AWS_REGION: scope.region, AWS_DEFAULT_REGION: scope.region } : {}),
  })
  if (!environment[PASSPHRASE_KEY]?.trim()) {
    throw new PulumiDeployError(
      `${PASSPHRASE_KEY} is required — Pulumi seals the state's secrets with it. Generate 32 random bytes ` +
        "once and put them in this stage's store:\n" +
        `  openssl rand -base64 32 | npm run mstage env set -- --stage <stage> ${PASSPHRASE_KEY}\n` +
        'Never replace it afterwards: every secret already in the state was sealed with this value, and a ' +
        'new one leaves them permanently unreadable. See iam/README.md.',
    )
  }

  const app = scope.app as string
  const stage = scope.stage as string
  log(
    `${NARRATION[intent]} ${components === 'api+runner' ? 'every component' : components + ' only'} of ${app} stage ${stage} ` +
      `${intent === 'remove' ? 'from' : 'into'} ${project ?? 'AWS'} (${scope.region}) with pulumi`,
  )

  /*
   * Asked before the engine is handed anything, because the answer decides
   * whether this apply can finish at all and the resources it would change
   * first are not free to change back.
   *
   * An apply only. A preview creates nothing, and a stage reads the same either
   * way — refusing the read would withhold the plan that shows the problem.
   * Skipped without a domain, which is a stage the engine is about to refuse
   * for that same reason, in its own words.
   */
  const domain = environment.STACK_DOMAIN
  if (scope.home === 'gcp' && project && intent === 'deploy' && domain && components === 'api+runner') {
    assertAuthorizationsConverge({
      app,
      stage,
      project,
      apiHost: publicHostsFor({ domain, dashboardDomain: environment.DASHBOARD_DOMAIN ?? null }).api,
      proxyDomain: environment.PROXY_DOMAIN ?? null,
      // This program is GCP's, whose edge serves the user domain's wildcard.
      appDomain: userDomainFrom(environment)?.domain ?? null,
      lookup: lookupAuthorizations ?? authorizationsThroughGcloud(spawnWith({ ...process.env, ...credentials })),
      log,
    })
  }

  const common = { app, stage, region: scope.region, environment, cwd: config.root }
  const stack = await createStackWith({
    projectName: app,
    stackName: stage,
    program:
      scope.home === 'aws'
        ? awsProgram({ ...common, stateBucket: state.bucket, protectedStage: scope.protect })
        : gcpProgram({ ...common, project: project!, zone: scope.zone }),
    /*
     * The whole stage environment, not only the credentials and the passphrase.
     * The engine spawns a provider plugin per provider, and those are the
     * processes that read `CLOUDFLARE_API_TOKEN` — narrowing this to what the
     * CLI itself needs would leave the DNS record unwritable.
     */
    envVars: environment,
    backendUrl: `${scope.home === 'aws' ? 's3' : 'gs'}://${state.bucket}`,
    ...(components === 'api+runner' ? {} : { selectOnly: true }),
  })

  let resources: DeployedResource[] = []
  if (components !== 'api+runner' || (scope.home === 'aws' && intent === 'remove')) {
    const checkpoint = await stack.exportStack()
    if (!Array.isArray(checkpoint.deployment?.resources))
      throw new PulumiDeployError('Cannot inspect the current stack resources')
    resources = checkpoint.deployment.resources
  }
  if (scope.home === 'aws' && intent === 'remove' && resources.some((resource) => resource.protect)) {
    throw new PulumiDeployError(
      'Protected resources remain; follow the retained-data teardown in docs/aws/deployment.md#retained-data-teardown before removal',
    )
  }
  const targets =
    components === 'api+runner'
      ? undefined
      : componentTargets({
          components,
          home: scope.home,
          app,
          stage,
          environment,
          resources,
        })
  if (targets) log(`pulumi targets: ${targets.join(', ')}`)

  // The provider's coordinates as stack configuration rather than as
  // environment: an inline program is not a subprocess, so what the engine is
  // told is what it uses.
  await stack.setAllConfig(
    scope.home === 'aws'
      ? {
          'aws:region': { value: scope.region },
          'aws:defaultTags': { value: JSON.stringify({ tags: { 'boxlite:app': app, 'boxlite:stage': stage } }) },
        }
      : {
          'gcp:project': { value: project! },
          'gcp:region': { value: scope.region },
        },
  )

  const onOutput = (output: string) => {
    for (const line of output.split('\n')) {
      const text = line.trim()
      if (!text || PROGRESS.test(text)) continue
      // The line as written, not trimmed: the engine's indentation is what
      // distinguishes a resource from the diagnostic block that follows it.
      log(line)
    }
  }
  const deadlineMs = Math.min(
    120 * 60_000,
    expiresAt ? Math.max(1, expiresAt.getTime() - Date.now() - 60_000) : Infinity,
  )
  const signal = scope.home === 'aws' ? AbortSignal.timeout(deadlineMs) : undefined
  try {
    signal?.throwIfAborted()
    await ACT[intent](stack, {
      onOutput,
      ...(signal ? { signal } : {}),
      ...(targets || (scope.home === 'aws' && intent === 'deploy') ? { refresh: true } : {}),
      ...(targets ? { target: targets, targetDependents: false } : {}),
    })
    return 0
  } catch (error) {
    // The engine already printed what failed; this says which stage it was, so
    // a workflow log that scrolled past the failure still names it.
    log(`pulumi ${intent} failed for ${app} stage ${stage}: ${(error as Error).message}`)
    return 1
  }
}

export type PulumiTargetInput = {
  config: Pick<MstageConfig, 'root'>
  scope: Scope
  identity: PulumiDeployInput['identity']
  /** Where this stage's configuration is read from, carried for the caller. */
  backend: StoreBackend
  /**
   * Asked at deploy time rather than resolved when the target is built. It is a
   * lookup against the bootstrap record, and a usage error should not spend one.
   */
  stateBucket: () => Promise<string>
  createStackWith?: StackFactory
}

/** Credentials, environment groups and state access are resolved once for either cloud. */
const cloudTarget = (
  cloud: Cloud,
  { config, scope, identity, backend, stateBucket, createStackWith }: PulumiTargetInput,
): DeployTarget => ({
  cloud,
  engine: 'pulumi',
  backend,
  // The passphrase on either intent: a teardown still has to open the state to
  // destroy what it describes.
  environmentGroups: (intent, declaration) => [
    ...(intent === 'remove' ? TEARDOWN_GROUPS : rolloutGroups(declaration)),
    PULUMI_GROUP,
  ],

  async run({ intent = 'deploy', components, stageEnvironment = {}, log }: DeployRequest): Promise<number> {
    deploymentComponents({ value: components, home: cloud, intent })
    return pulumiDeploy({
      intent,
      components,
      config,
      scope,
      identity,
      stageEnvironment,
      log,
      state: { bucket: await stateBucket() },
      ...(createStackWith ? { createStackWith } : {}),
    })
  },
})

export const gcpTarget = (input: PulumiTargetInput): DeployTarget => cloudTarget('gcp', input)
export const awsTarget = (input: PulumiTargetInput): DeployTarget => cloudTarget('aws', input)
