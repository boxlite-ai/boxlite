/**
 * `npm run mdeploy -- --stage <stage>`.
 *
 * Every question about who you are and what a stage means is mstage's: this parses
 * the same way, loads the same config, resolves the same identity, and refuses
 * to start until mstage says the sign-ins this repository declares are all good.
 * What is left is the deploy itself.
 */

import { parseInvocation, type Options } from 'mstage/cli'
import { loadConfig } from 'mstage/config'
import { resolveScope } from 'mstage/scope'
import { run as mstage } from 'mstage/run'
import { resolveDeployTarget } from './deploy.ts'
import type { Intent } from './deploy.ts'
import { ambientEnvironment, assertAddressesAreNotSpent, fetchStageEnvironment, type StageEnvironment } from './env.ts'

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

const USAGE = [
  'usage: npm run mdeploy -- --stage <stage> [--confirm] [--local-env]',
  '       npm run mdeploy -- --stage <stage> --diff',
  '       npm run mdeploy -- --stage <stage> --refresh',
  '       npm run mdeploy -- --stage <stage> --remove --confirm',
  '',
  '--refresh reconciles the state with the cloud and clears the operations an',
  'interrupted run left pending. It changes no resource; it rewrites what this',
  'stage believes about them.',
].join('\n')

/** mdeploy's own switches. mstage parses them but never advertises them. */
const OWN_OPTIONS = { flags: ['local-env', 'diff', 'remove', 'refresh'] }

export type RunInput = {
  argv: string[]
  environment?: NodeJS.ProcessEnv
  cwd?: string
  log?: (line: string) => void
  checkLogin?: typeof mstage
  /** The one dispatch: which cloud this repository lives in, and what serves it. */
  targetWith?: typeof resolveDeployTarget
  fetchEnv?: typeof fetchStageEnvironment
}

export const run = async ({
  argv,
  environment = process.env,
  cwd = process.cwd(),
  log = console.log,
  checkLogin = mstage,
  targetWith = resolveDeployTarget,
  fetchEnv = fetchStageEnvironment,
}: RunInput): Promise<number> => {
  if (argv[0] === 'help' || argv[0] === '--help') {
    log(USAGE)
    return 0
  }

  // mdeploy takes options only. The leading word keeps mstage's parser honest
  // about what it is looking at, and is stripped before anything reads it.
  const { options, inner } = parseInvocation(['deploy', ...argv], environment, OWN_OPTIONS)
  if (inner) throw new UsageError(`mdeploy takes no inner command. ${USAGE}`)

  const config = loadConfig({ cwd, environment })
  const scope = resolveScope({ options: options as Options, config, environment })

  /*
   * Ask mstage first: a deploy that starts without a usable session fails later
   * and more expensively than one that never starts.
   *
   * Named with the stage, because which sign-ins this deploy needs is the
   * stage's question rather than the repository's. A repository with stages in
   * both clouds declares both, and without the stage an expired session in the
   * cloud this deploy does not touch refuses it — which is what an AWS session
   * timing out did to a GCP stage that needed no AWS credential at all.
   */
  const signedIn = await checkLogin({
    argv: ['login', ...(scope.stage ? ['--stage', scope.stage] : [])],
    environment,
    cwd,
    log,
  })
  if (signedIn !== 0) throw new UsageError('Required sign-ins are missing; run `npm run mstage login -- -f` first')
  // One intent, named once. Three switches rather than two, so the pair test
  // this replaces would have let `--diff --refresh` through.
  const named = [options.diff === true && 'diff', options.remove === true && 'remove', options.refresh === true && 'refresh'].filter(
    Boolean,
  ) as Intent[]
  if (named.length > 1) throw new UsageError(`${named.map((one) => `--${one}`).join(' and ')} ask for different things; name one`)
  const intent: Intent = named[0] ?? 'deploy'
  // A protected stage is asked before its state is rewritten, for the reason it
  // is asked before a rollout: the resources are the same ones, and a refresh
  // that reads a resource as gone is the first half of recreating it.
  if (intent === 'refresh' && scope.protect && options.confirm !== true) {
    throw new UsageError(`Stage "${scope.stage}" is protected in ${config.path}. Add --confirm to refresh it.`)
  }
  if (intent === 'deploy' && scope.protect && options.confirm !== true) {
    throw new UsageError(`Stage "${scope.stage}" is protected in ${config.path}. Add --confirm to deploy it.`)
  }
  // A teardown is the one thing no flag should be able to talk a protected
  // stage into: `protect` also stops SST mid-run, and discovering that twenty
  // minutes in is worse than being told now. Removing prod is an edit to
  // mstage.config.json, made deliberately and reviewed.
  if (intent === 'remove' && scope.protect) {
    throw new UsageError(
      `Stage "${scope.stage}" is protected in ${config.path} and cannot be removed. ` +
        `Clear stages.${scope.stage}.protect there first.`,
    )
  }
  // Every teardown is confirmed, not only a protected one: the stages that are
  // not protected are exactly the ones whose database is deleted with them.
  if (intent === 'remove' && options.confirm !== true) {
    throw new UsageError(
      `Removing stage "${scope.stage}" destroys its database and every other resource. Add --confirm.`,
    )
  }
  // The repository's cloud, resolved once. Everything below holds the bundle it
  // produced and never asks which cloud answered.
  const target = await targetWith({ config, scope })

  // Before the store is read, so a declaration no workload could honour stops
  // the command rather than the deploy that spends what it fetched.
  assertAddressesAreNotSpent(config)

  const stageEnvironment: StageEnvironment =
    options['local-env'] === true
      ? ambientEnvironment()
      : await fetchEnv({
          config,
          scope,
          backend: target.backend,
          groups: target.environmentGroups(intent, config),
        })
  const names = Object.keys(stageEnvironment.values)
  // Names, never values: this is the line that would otherwise put the store
  // into a CI log.
  log(`environment from ${stageEnvironment.source}${names.length > 0 ? `: ${names.join(', ')}` : ''}`)

  return target.run({ intent, stageEnvironment: stageEnvironment.values, log })
}
