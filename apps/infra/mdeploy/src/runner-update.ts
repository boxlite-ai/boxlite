/*
 * `npm run runner:update -- --stage <stage> [--version X.Y.Z] [--allow-downgrade]`
 *
 * Rolling the fleet's binary by hand, outside a deploy — and the only way to
 * move it *backwards*.
 *
 * A deploy already rolls the fleet forward: `stack/runner-upgrade.ts` renders
 * the payload and each provider chains one command per host. What a deploy
 * deliberately cannot do is downgrade. The payload refuses to replace a host
 * serving something newer than the target, because a host ahead of the declared
 * version is usually a deliberate hand-install and silently reverting it during
 * an unrelated deploy is a nasty surprise. That refusal exits 0, so a rollback
 * attempted by editing the version would report success and change nothing.
 *
 * So the force lives here instead of in the deploy, and that is the whole design
 * decision: a rollback is a decision someone makes, at a moment, watching the
 * output — not a state a stage's configuration can be left in. A stored flag
 * would be a stage that quietly permits downgrades on every future deploy, which
 * is exactly the surprise the guard exists to prevent.
 *
 * Everything else is shared with the deploy rather than reimplemented: the same
 * `renderUpgradePayload` converge/verify/swap/rollback script, the same
 * transports in `upgrade-runners.ts`, the same host-at-a-time sequencing that
 * stops on the first failure. This file only answers the two questions a deploy
 * answers structurally — which hosts, and in what order.
 *
 * Release targets only. A build-mode binary is addressed by a commit and staged
 * per stage; installing one is what a deploy of that commit does. A rollback
 * names a published version.
 */

import { parseInvocation, type Options } from 'mstage/cli'
import { loadConfig } from 'mstage/config'
import { resolveHome } from 'mstage/home'
import { run as mstage } from 'mstage/run'
import { resolveScope } from 'mstage/scope'
import { deployRoot } from './config.ts'
import { sleepSeconds, spawnWith, upgradeOne, type RunCommand, type UpgradeOneRequest } from './upgrade-runners.ts'
import { encodeUpgradePayload } from '../stack/runner-upgrade.ts'
import { RUNNER_PORT } from '../stack/runners.ts'
import { resolveRunnerBinary } from '../stack/runner-binary.ts'
import { zoneIn } from '../stack/providers/gcp/index.ts'

export class RunnerUpdateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunnerUpdateError'
  }
}

const USAGE = [
  'usage: npm run runner:update -- --stage <stage> [--version <X.Y.Z>] [--host <name>[,<name>…]]',
  '                                [--allow-downgrade] [--confirm]',
  '',
  '  --version          a published release. Defaults to the checkout’s own version.',
  '  --host             only these hosts, by the name the console shows. Default: every one.',
  '  --allow-downgrade  replace a host serving something NEWER. This is the rollback.',
  '  --confirm          required for a stage mstage.config.json marks protected.',
].join('\n')

/**
 * This tool's own switches. mstage parses them but never advertises them.
 *
 * `--version` and `--confirm` are not here because mstage already knows both —
 * which is worth having rather than shadowing: its own guard catches the
 * `npm run … --version 0.9.5` that npm swallows before this ever runs.
 */
const OWN_OPTIONS = { flags: ['allow-downgrade'], values: ['host'] }

/**
 * How each cloud names a runner, which is also how each is found.
 *
 * The providers set both: AWS tags the instance `Name=boxlite-runner-*`, GCP
 * names it the same thing. Discovery matches that pattern rather than reading
 * the engine's state — a state file is one deploy's record, and this tool has to
 * work on a fleet whose last deploy failed halfway.
 */
const NAME_PATTERN = 'boxlite-runner-'

export type Host = { target: string; label: string }

/**
 * The order the fleet was created in, which is the order to visit it in.
 *
 * Not the API's order — neither cloud promises one, and a roll that took what
 * it was given would visit the fleet differently every run, which defeats the
 * point of going one at a time: after a failure, *which* hosts are still
 * serving has to be knowable.
 *
 * Not lexicographic either, and that is the part worth stating. `stack-env.ts`
 * names the first host `boxlite-runner-default` and every later one
 * `boxlite-runner-<n>`, so sorting by string puts `-2` before `-default` and
 * `-10` before `-2`. The fleet's own order is: the first host, then the rest by
 * number — the same order the deploy's `dependsOn` chain walks.
 */
const numbered = (label: string): number | null => {
  const suffix = label.startsWith(NAME_PATTERN) ? label.slice(NAME_PATTERN.length) : label
  if (suffix === 'default') return 0
  return /^[0-9]+$/.test(suffix) ? Number(suffix) : null
}

export const compareHosts = (left: Host, right: Host): number => {
  const [a, b] = [numbered(left.label), numbered(right.label)]
  // A host neither pattern explains — renamed by hand, or from another fleet —
  // goes last, in its own stable order, rather than jumping the queue.
  if (a === null || b === null) {
    if (a === null && b === null) return left.label.localeCompare(right.label)
    return a === null ? 1 : -1
  }
  return a - b
}

/** Every running runner in the stage's region, in a stable order. */
const awsHosts = (region: string, run: RunCommand): Host[] => {
  const listed = run('aws', [
    'ec2',
    'describe-instances',
    '--region',
    region,
    '--filters',
    `Name=tag:Name,Values=${NAME_PATTERN}*`,
    'Name=instance-state-name,Values=running',
    '--query',
    'Reservations[].Instances[].[InstanceId,Tags[?Key==`Name`].Value|[0]]',
    '--output',
    'text',
  ])
  if (!listed.ok) throw new RunnerUpdateError(`could not list the fleet: ${listed.stderr || '(no stderr)'}`)
  return listed.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([id]) => id && id !== 'None')
    .map(([target, label]) => ({ target: target as string, label: label ?? (target as string) }))
    .sort(compareHosts)
}

const gcpHosts = ({ project, zone, run }: { project: string; zone: string; run: RunCommand }): Host[] => {
  const listed = run('gcloud', [
    'compute',
    'instances',
    'list',
    `--project=${project}`,
    `--zones=${zone}`,
    `--filter=name~^${NAME_PATTERN} AND status=RUNNING`,
    '--format=value(name)',
  ])
  if (!listed.ok) throw new RunnerUpdateError(`could not list the fleet: ${listed.stderr || '(no stderr)'}`)
  return listed.stdout
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean)
    // The name *is* the target on this cloud: `gcloud compute ssh` takes it.
    .map((name) => ({ target: name, label: name }))
    .sort(compareHosts)
}

/** The subset an operator named, or all of them. Naming one that is not there is a mistake, not a filter. */
const selected = (hosts: Host[], named: string[]): Host[] => {
  if (named.length === 0) return hosts
  const missing = named.filter((name) => !hosts.some((host) => host.label === name || host.target === name))
  if (missing.length > 0) {
    throw new RunnerUpdateError(
      `${missing.join(', ')} is not a running runner in this stage. Found: ${hosts.map((host) => host.label).join(', ') || 'none'}`,
    )
  }
  return hosts.filter((host) => named.includes(host.label) || named.includes(host.target))
}

export type UpdateInput = {
  argv: string[]
  environment?: NodeJS.ProcessEnv
  cwd?: string
  log?: (line: string) => void
  checkLogin?: typeof mstage
  resolveHomeWith?: typeof resolveHome
  /** Injected so a roll is provable without an account, a project or a host. */
  run?: RunCommand
  sleep?: (seconds: number) => void
}

export const updateRunners = async ({
  argv,
  environment = process.env,
  cwd = process.cwd(),
  log = console.log,
  checkLogin = mstage,
  resolveHomeWith = resolveHome,
  run: injectedRun,
  sleep = sleepSeconds,
}: UpdateInput): Promise<number> => {
  if (argv[0] === 'help' || argv[0] === '--help') {
    log(USAGE)
    return 0
  }

  const { options, inner } = parseInvocation(['roll', ...argv], environment, OWN_OPTIONS)
  if (inner) throw new RunnerUpdateError(`runner:update takes no inner command.\n${USAGE}`)

  const config = loadConfig({ cwd, environment })
  // `resolveScope` refuses a missing --stage itself, and names the stages this
  // repository declares while doing it.
  const scope = resolveScope({ options: options as Options, config, environment })

  // Same gate a deploy applies, for the same reason: this restarts every runner
  // in the fleet, and boxes on a host take the restart.
  if (scope.protect && options.confirm !== true) {
    throw new RunnerUpdateError(`Stage "${scope.stage}" is protected in ${config.path}. Add --confirm to roll its fleet.`)
  }

  // Named with the stage, because which sign-ins this needs is the stage's
  // question: a repository with stages in both clouds declares both, and
  // without the stage an expired session in the cloud this fleet does not live
  // in would refuse the roll.
  const signedIn = await checkLogin({ argv: ['login', '--stage', scope.stage as string], environment, cwd, log })
  if (signedIn !== 0) throw new RunnerUpdateError('Required sign-ins are missing; run `npm run mstage login -- -f` first')

  const version = (options.version as string | undefined)?.trim()
  const allowDowngrade = options['allow-downgrade'] === true
  const named = (options.host as string | undefined)
    ?.split(',')
    .map((name) => name.trim())
    .filter(Boolean) ?? []

  /*
   * The same resolution the stack does, forced to release.
   *
   * `VERSION` is the selector `stack/runner-binary.ts` already honours, so a
   * named version reaches it the way a deploy's would — one resolver, one set of
   * asset names. The artifact source is pinned to `release` rather than
   * inherited: a build is addressed by a commit and staged per stage, and
   * installing one is what deploying that commit does.
   */
  const binary = resolveRunnerBinary({
    environment: {
      ...environment,
      ...(version ? { VERSION: version } : {}),
      RUNNER_ARTIFACT_SOURCE: 'release',
      BOXLITE_ARTIFACT_SOURCE: 'release',
    },
    configRoot: deployRoot({ cwd, environment }),
  })

  const home = await resolveHomeWith({ scope })
  const { env: credentials } = await home.identity.childEnvironment()
  const run = injectedRun ?? spawnWith({ ...environment, ...credentials })

  const hosts = selected(
    home.identity.home === 'aws'
      ? awsHosts(scope.region as string, run)
      : gcpHosts({ project: scope.project as string, zone: zoneIn(scope.region as string, scope.zone ?? null), run }),
    named,
  )
  if (hosts.length === 0) throw new RunnerUpdateError(`no running runner in ${config.app}/${scope.stage}`)

  const payload = encodeUpgradePayload({
    identity: binary.identity,
    binary,
    port: RUNNER_PORT,
    region: home.identity.home === 'aws' ? (scope.region as string) : null,
    allowDowngrade,
  })

  log(`==> rolling ${hosts.length} host(s) in ${config.app}/${scope.stage} to ${binary.identity}`)
  log(`==> artifact: ${binary.tarballUrl}`)
  if (allowDowngrade) log('==> --allow-downgrade: a host serving something newer WILL be replaced')

  for (const [index, host] of hosts.entries()) {
    log(`==> [${index + 1}/${hosts.length}]`)
    const request = {
      identity: binary.identity,
      payload,
      label: host.label,
      ...(home.identity.home === 'aws'
        ? { cloud: 'aws' as const, target: host.target, region: scope.region as string }
        : {
            cloud: 'gcp' as const,
            target: host.target,
            project: scope.project as string,
            zone: zoneIn(scope.region as string, scope.zone ?? null),
          }),
    } satisfies UpgradeOneRequest
    // Sequential, and a failure stops the roll: the hosts not yet visited keep
    // serving what they were serving. The same property the deploy gets from
    // its dependency chain.
    upgradeOne(request, { run, sleep, log })
  }

  /*
   * Deliberately does not assert the fleet is at the target.
   *
   * A host can be skipped as already-serving-it, left alone as still
   * bootstrapping, or refused as a downgrade — the per-host lines above say
   * which, and a blanket "all at vX" would be false for every one of those.
   */
  log(`==> done (${hosts.length} host(s))`)
  return 0
}
