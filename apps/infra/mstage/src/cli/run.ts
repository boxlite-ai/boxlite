/**
 * Dispatches one mstage invocation.
 *
 * Everything here is shared across repositories; deployment is not. mstage
 * creates and verifies access, and never spends it.
 */

import {
  STAGE_FILENAME,
  loadConfig,
  loadEnvFile,
  stageIn,
  type LoginRequirement,
  type MstageConfig,
} from '../config/load.ts'
import { resolveIdentity, type AwsIdentity } from '../aws/identity.ts'
import { resolveHome } from '../home.ts'
import type { Identity } from '../identity.ts'
import type { StoreBackend } from '../env/backend.ts'
import { resolveScope, type Scope } from '../aws/precedence.ts'
import { parseInvocation, type Options } from './argv.ts'
import { moduleUsage, type CommandSpec, type ModuleSpec } from './help.ts'
import * as aws from './handlers/aws.ts'
import * as configVariable from './handlers/config.ts'
import * as env from './handlers/env.ts'
import * as state from './handlers/state.ts'
import { checkAws, report, type ProviderCheck, type ProviderStatus } from './handlers/login.ts'
import {
  SIGN_IN_COMMANDS,
  SIGN_OUT_COMMANDS,
  checkAuth0,
  checkGcp,
  checkGitHub,
  signIn,
  signOut,
  type SignInResult,
} from '../auth/sessions.ts'
import { confirm as askConfirm, isInteractive, type Confirm } from './prompt.ts'

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export type Log = (line: string) => void

const AWS_COMMANDS: Record<string, CommandSpec> = {
  whoami: {
    run: aws.whoami,
    summary: 'Which identity, tenant and region this stage resolves to',
    requires: ['stage'],
  },
  region: {
    run: aws.region,
    summary: 'The region this stage resolves to, and why',
    requires: ['stage'],
  },
  exec: {
    run: aws.exec,
    summary: 'Run another command under that identity',
    inner: 'required',
    requires: ['stage'],
  },
}

const ENV_COMMANDS: Record<string, CommandSpec> = {
  list: {
    run: env.list,
    summary: "A stage's environment, by name",
    requires: ['stage'],
    accepts: ['select-group', 'json', 'values', 'version'],
  },
  set: {
    run: env.set,
    summary: 'Set one or more keys in a stage',
    argument: {
      form: 'KEY=VALUE …',
      description: 'assignments; a lone KEY reads stdin',
      optional: 'piped JSON or --digest supplies them',
    },
    requires: ['stage'],
    accepts: ['confirm', 'digest', 'json', 'select-group'],
  },
  versions: {
    run: env.versions,
    summary: 'Every stored version of a stage, newest first',
    requires: ['stage'],
  },
  digest: {
    run: env.digest,
    summary: 'Check the stored fingerprint still describes its group',
    requires: ['stage'],
  },
  del: {
    run: env.del,
    summary: 'Remove one or more keys from a stage',
    argument: { form: 'KEY …', description: 'the names to remove' },
    requires: ['stage'],
    accepts: ['confirm', 'digest'],
  },
}

const STATE_COMMANDS: Record<string, CommandSpec> = {
  unlock: {
    run: state.unlock,
    summary: 'Drop the lock a stopped deploy left on this stage',
    requires: ['stage'],
    accepts: ['confirm'],
  },
  edit: {
    run: state.edit,
    summary: "Open this stage's deployment state in $EDITOR",
    requires: ['stage'],
    accepts: ['confirm'],
  },
}

/** Shared by every stage-scoped command, so they are listed once per module. */
const STAGE_OPTIONS = ['app', 'region', 'role-arn', 'role-session-name']

/**
 * Every provider mstage knows how to check. The stage file selects which of them
 * a repository requires; it does not define the set, so all of them are
 * documented whether or not this repository has enabled them.
 */
const LOGIN_PROVIDERS: Record<string, { check: ProviderCheck; summary: string }> = {
  aws: { check: checkAws, summary: 'AWS credentials, through the SDK default chain' },
  gcp: { check: checkGcp as ProviderCheck, summary: 'Google application default credentials' },
  // These two read a CLI session and ignore the AWS identity in the context.
  github: { check: checkGitHub as ProviderCheck, summary: 'The gh CLI session, and which account it holds' },
  auth0: { check: checkAuth0 as ProviderCheck, summary: 'The auth0 CLI session, and its active tenant' },
}

const LOGIN_CHECKS: Record<string, ProviderCheck> = Object.fromEntries(
  Object.entries(LOGIN_PROVIDERS).map(([key, provider]) => [key, provider.check]),
)

const LOGIN_COMMANDS: Record<string, CommandSpec> = Object.fromEntries(
  Object.entries(LOGIN_PROVIDERS).map(([key, provider]) => [key, { summary: provider.summary }]),
)

const CONFIG_COMMANDS: Record<string, CommandSpec> = {
  put: {
    run: configVariable.put,
    summary: "Send this stage's block to its GitHub environment",
    requires: ['stage'],
  },
  get: {
    run: configVariable.get,
    summary: 'Print that block as JSON, from the variable or the file',
    requires: ['stage'],
  },
}

const MODULES: Record<string, ModuleSpec> = {
  login: {
    summary: 'Check every sign-in this repository declares',
    scope: 'login',
    commands: LOGIN_COMMANDS,
    commandNote:
      'omit the command to act on every provider any stage declares;\n' +
      'naming one no stage declares is refused;\n' +
      '--stage narrows it to what that one stage needs signed in',
    accepts: ['force', 'logout', 'region', 'stage'],
    example: 'npm run mstage login github -- --force',
  },
  aws: {
    summary: 'The identity a stage resolves to, on whichever cloud it lives in',
    scope: 'stage',
    commands: AWS_COMMANDS,
    accepts: STAGE_OPTIONS,
    example: 'npm run mstage aws exec -- --stage=dev -- gcloud storage ls',
  },
  config: {
    summary: "A stage's own declaration, carried to and from its GitHub environment",
    scope: 'declaration',
    commands: CONFIG_COMMANDS,
    commandNote:
      'put reads stdin when something piped it, and .mstage.config.json when nothing did;\n' +
      'get reads the variable first and that file second, so one command works in both places',
    accepts: ['stage'],
    example: 'npm run mstage config get -- --stage=dev',
  },
  env: {
    summary: "A stage's environment, read from the SST state bucket",
    scope: 'stage',
    commands: ENV_COMMANDS,
    accepts: STAGE_OPTIONS,
    example: 'npm run mstage env list -- --stage=dev --select-group=deploy --json > .deploy.env.json',
  },
  state: {
    summary: 'What a stopped deploy left in that bucket: a lock, and a checkpoint',
    scope: 'stage',
    commands: STATE_COMMANDS,
    commandNote:
      'a cancelled deploy leaves both: the lock it never released, and the\n' +
      'operations it was in the middle of, which the next deploy refuses to plan over',
    accepts: STAGE_OPTIONS,
    example: 'npm run mstage state unlock -- --stage=dev',
  },
}

/** Every module the dispatcher knows, named once so nothing keeps a second list. */
export const MODULE_NAMES = Object.keys(MODULES)

export const usage = (): string => {
  const lines = ['usage: npm run mstage <module> <command> -- [--stage <stage>] [options] [-- <inner command>]', '']
  lines.push('modules')
  // Measured, not a fixed width: `versions` is exactly eight characters, so a
  // padEnd(8) ran its summary straight into it with no space between.
  const widest = (names: string[]) => Math.max(...names.map((name) => name.length)) + 2
  const moduleWidth = widest(Object.keys(MODULES))
  const commandWidth = widest(Object.values(MODULES).flatMap((module) => Object.keys(module.commands ?? {})))
  for (const [name, module] of Object.entries(MODULES)) {
    lines.push(`  ${name.padEnd(moduleWidth)}${module.summary}`)
    for (const [command, spec] of Object.entries(module.commands ?? {})) {
      lines.push(`    ${command.padEnd(commandWidth)}${spec.summary}`)
    }
  }
  lines.push('', `login providers are declared per stage in ${STAGE_FILENAME}`)
  lines.push('  -f, --force  sign in again first, instead of only reporting the current session')
  lines.push('      --logout  end the current session instead of checking it')
  lines.push('', 'every option must sit to the right of the "--"; npm claims anything left of it')
  return lines.join('\n')
}

const buildStageContext = async ({
  options,
  environment,
  cwd,
}: {
  options: Options
  environment: NodeJS.ProcessEnv
  cwd: string
}): Promise<{ config: MstageConfig; scope: Scope; identity: Identity; backend: StoreBackend }> => {
  const config = loadConfig({ cwd, environment })
  const scope = resolveScope({ options, config, environment })
  // The one place a cloud is chosen. Everything below works against the two
  // interfaces and never learns which one answered.
  const { identity, backend } = await resolveHome({ scope })
  return { config, scope, identity, backend }
}

// `login` answers "is there a usable session", which is not a per-stage
// question. Only the AWS check needs anything from this context, and only a
// region to build an STS client with: it picks an endpoint and is never
// reported, because it describes nothing.
/**
 * The stage a declaration command acts on, taken straight from the invocation.
 *
 * Not through `resolveScope`, which reads the stage file to check the name
 * against what is declared — the file this command exists to work without.
 */
const stageNamed = (options: Options): string => {
  const stage = options.stage
  if (typeof stage !== 'string' || stage.trim() === '') throw new UsageError('--stage is required')
  return stage
}

const STS_ENDPOINT_REGION_FALLBACK = 'us-east-1'

const buildLoginContext = ({
  options,
  environment,
}: {
  options: Options
  environment: NodeJS.ProcessEnv
}): { identity: AwsIdentity } => {
  const region =
    (options.region as string) ??
    environment.AWS_REGION ??
    environment.AWS_DEFAULT_REGION ??
    STS_ENDPOINT_REGION_FALLBACK
  return { identity: resolveIdentity({ scope: { region, roleArn: null } as Scope }) }
}

/**
 * What this invocation actually needs signed in.
 *
 * A stage answers for itself: it declares what reaching it costs, and a stage
 * in one cloud names no credential for the other. Read repository-wide
 * instead, an expired AWS session refused a GCP deploy on a machine that
 * needed no AWS credential to perform it.
 *
 * Without a stage the question is whether this checkout can work at all, so
 * every stage's declaration is merged. Required wins over optional: a provider
 * one stage cannot do without is one this checkout cannot do without, and
 * reporting it optional would forgive the session that stage needs.
 */
export const requirementsFor = ({
  config,
  stage,
}: {
  config: Pick<MstageConfig, 'stages' | 'path'>
  stage: string | undefined
}): Record<string, LoginRequirement> => {
  if (stage) return stageIn(config, stage).login
  const merged: Record<string, LoginRequirement> = {}
  for (const declared of Object.values(config.stages)) {
    for (const [provider, requirement] of Object.entries(declared.login)) {
      merged[provider] = { required: (merged[provider]?.required ?? false) || requirement.required }
    }
  }
  return merged
}

const runLogin = async ({
  command,
  options,
  environment,
  cwd,
  log,
  signInWith,
  signOutWith,
  confirm,
  interactive,
  checks,
}: {
  command: string | null
  options: Options
  environment: NodeJS.ProcessEnv
  cwd: string
  log: Log
  signInWith: (provider: string) => SignInResult
  signOutWith: (provider: string) => SignInResult
  confirm: Confirm
  interactive: boolean
  checks: Record<string, ProviderCheck>
}): Promise<number> => {
  const declared = requirementsFor({ config: loadConfig({ cwd, environment }), stage: options.stage as string | undefined })
  if (Object.keys(declared).length === 0) {
    throw new UsageError(`${STAGE_FILENAME} declares no login providers on any stage, so there is nothing to check`)
  }
  for (const provider of Object.keys(declared)) {
    if (!(provider in checks)) {
      throw new UsageError(
        `${STAGE_FILENAME} declares "${provider}", which mstage cannot check. Known: ${Object.keys(checks).join(', ')}`,
      )
    }
  }
  const wanted = command === null ? Object.keys(declared) : [command]
  for (const provider of wanted) {
    if (!(provider in declared)) {
      throw new UsageError(
        `No stage here uses "${provider}". ${STAGE_FILENAME} declares: ${Object.keys(declared).join(', ')}`,
      )
    }
  }

  if (options.logout === true && options.force === true) {
    throw new UsageError('--logout and --force ask for opposite things; pass one')
  }

  // Signing out first, so the report that follows describes what is left rather
  // than what was there. Nothing is offered afterwards: someone who just asked
  // to sign out does not want to be asked to sign back in.
  if (options.logout === true) {
    for (const provider of wanted) {
      // Every step, in order: on GCP a sign-out is two commands, and naming
      // one of them would describe half of what is about to happen.
      const ending = SIGN_OUT_COMMANDS[provider]?.map((argv) => argv.join(' ')).join(' then ')
      log(`${provider.padEnd(8)}signing out: ${ending}`)
      const attempt = signOutWith(provider)
      if (!attempt.ok) log(`        ${attempt.detail}`)
    }
  }

  // A forced sign-in runs before the check, so what gets reported is the session
  // that now exists rather than the one that did a moment ago.
  if (options.force === true) {
    for (const provider of wanted) {
      // Every step, in order: on GCP a sign-in is two commands, and naming one
      // of them would describe half of what is about to happen.
      const starting = SIGN_IN_COMMANDS[provider]?.map((argv) => argv.join(' ')).join(' then ')
      log(`${provider.padEnd(8)}signing in: ${starting}`)
      const attempt = signInWith(provider)
      if (!attempt.ok) log(`        ${attempt.detail}`)
    }
  }

  const context = buildLoginContext({ options, environment })
  const check = async (provider: string): Promise<ProviderStatus> => ({
    ...(await checks[provider]!(context)),
    required: declared[provider]!.required,
  })

  const statuses: ProviderStatus[] = []
  for (const provider of wanted) {
    let status = await check(provider)

    // A required provider that is not signed in is the one case worth
    // interrupting for: everything after it fails anyway, and the fix is one
    // command the operator has to complete at browser speed. Optional providers
    // are reported and stepped over, and without a terminal there is nobody to
    // ask — CI gets the report and the exit code and nothing else.
    if (status.state !== 'ready' && status.required && interactive && options.logout !== true) {
      const command = SIGN_IN_COMMANDS[provider]?.map((argv) => argv.join(' ')).join('` then `') ?? provider
      log(`${provider.padEnd(8)}${status.state}`)
      log(`        ${status.detail}`)
      if (await confirm(`        Run \`${command}\` now? [y/N] `)) {
        const attempt = signInWith(provider)
        if (!attempt.ok) log(`        ${attempt.detail}`)
        // Re-check rather than trusting the exit status: `gh auth status --json`
        // exits zero on a broken session, and a cancelled browser flow can too.
        status = await check(provider)
      }
    }
    statuses.push(status)
  }
  return report({ statuses, log })
}

const helpFor = (module: string): string => {
  const spec = MODULES[module]
  if (!spec) throw new UsageError(`Unknown module "${module}". Known modules: ${MODULE_NAMES.join(', ')}`)
  return moduleUsage(module, spec)
}

export const run = async ({
  argv,
  environment = process.env,
  cwd = process.cwd(),
  log = console.log,
  signInWith = signIn,
  signOutWith = signOut,
  confirm = askConfirm,
  interactive = isInteractive(),
  checks = LOGIN_CHECKS,
}: {
  argv: string[]
  environment?: NodeJS.ProcessEnv
  cwd?: string
  log?: Log
  signInWith?: (provider: string) => SignInResult
  signOutWith?: (provider: string) => SignInResult
  confirm?: Confirm
  interactive?: boolean
  checks?: Record<string, ProviderCheck>
}): Promise<number> => {
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help') {
    log(usage())
    return argv.length === 0 ? 1 : 0
  }

  const { module, command, options, positionals, inner } = parseInvocation(argv, environment)
  if (options.help === true) {
    log(helpFor(module))
    return 0
  }
  const spec = MODULES[module]
  if (!spec) throw new UsageError(`Unknown module "${module}". Known modules: ${MODULE_NAMES.join(', ')}`)
  if (spec.scope === 'login') {
    return runLogin({
      command,
      options,
      environment,
      cwd,
      log,
      signInWith,
      signOutWith,
      confirm,
      interactive,
      checks,
    })
  }

  const commandSpec = spec.commands?.[command as string]
  if (!commandSpec) {
    const known = Object.keys(spec.commands ?? {}).join(', ')
    throw new UsageError(`Unknown command "${command ?? '<none>'}" for module ${module}. Known commands: ${known}`)
  }
  if (commandSpec.argument) {
    if (positionals.length === 0 && !commandSpec.argument.optional) {
      throw new UsageError(`mstage ${module} ${command} needs ${commandSpec.argument.form}`)
    }
  } else if (commandSpec.inner !== 'required' && inner) {
    throw new UsageError(`mstage ${module} ${command} takes no inner command`)
  }

  /*
   * `config` resolves no cloud, deliberately. Its whole point is a runner that
   * has the stage as a variable and no stage file at all — and `resolveHome`
   * would demand both that file and a credential, neither of which reading a
   * declaration needs.
   */
  const context =
    spec.scope === 'declaration'
      ? { app: loadEnvFile({ cwd, environment }).app, stage: stageNamed(options), environment, cwd }
      : await buildStageContext({ options, environment, cwd })
  if (!commandSpec.run) throw new UsageError(`mstage ${module} ${command} cannot be run directly`)
  const result = await commandSpec.run({ ...context, options, positionals, inner, log })
  return typeof result === 'number' ? result : 0
}
