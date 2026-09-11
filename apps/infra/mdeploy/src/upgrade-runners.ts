// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Lands one host's runner binary, over whichever channel its cloud offers.
 *
 * `stack/runner-upgrade.ts` says why this exists and renders what the host runs;
 * this is the deployer's half — reach the host, run the payload, and report a
 * verdict the engine can fail on. One host per invocation: each provider creates
 * one command per host and chains them, so sequencing is the dependency graph's
 * job and not this file's.
 *
 * The two channels are not equivalent and the difference is worth stating:
 *
 *   aws → `ssm send-command`, which is asynchronous. SSM accepts the command and
 *         the deployer polls for a terminal status. Nothing cancels an accepted
 *         command, so the supervision window has to stay above what the payload
 *         can actually take — giving up first would report failure while the host
 *         went on to swap the unit anyway.
 *   gcp → `gcloud compute ssh --tunnel-through-iap`, which is synchronous: the
 *         remote exit status is the verdict and there is nothing to poll.
 *
 * IAP rather than a startup script, and the reasoning is the opposite of
 * `providers/gcp/clickhouse.ts`'s. There the reconcile could live in the startup
 * script and pay "applied at boot" as its cost. Here it cannot: the runner's
 * script is in `ignoreChanges` and the instance is `protect: true`, so a host
 * that exists never boots into a new script — "at boot" would mean "never". A
 * tunnelled ssh needs no inbound port and no key of ours (gcloud mints and
 * propagates one), which is what makes it the smaller cost of the two.
 *
 * Env:
 *   RUNNER_UPGRADE_CLOUD     aws | gcp — which channel reaches the host
 *   RUNNER_UPGRADE_TARGET    the EC2 instance id, or the GCE instance name
 *   RUNNER_UPGRADE_LABEL     the host as the control plane knows it, for the log
 *   RUNNER_UPGRADE_IDENTITY  what the host should serve once this is done
 *   RUNNER_UPGRADE_PAYLOAD   the script, base64-encoded
 *   AWS_REGION               aws only
 *   GCP_PROJECT, GCP_ZONE    gcp only
 */

import { spawnSync } from 'node:child_process'
import { ON_HOST } from '../stack/runner-upgrade.ts'

/** ~5 min at 10s apart, which covers an agent registering on a fresh instance. */
const CONNECT_ATTEMPTS = 30
const CONNECT_PAUSE_SECONDS = 10
/**
 * ~30 min at 5s apart. It has to stay above everything the payload can bound —
 * a 300s fetch and a 60s readiness gate — with room for the apt/tar/systemctl
 * steps that take no timeout at all. Read it as "supervision must exceed
 * everything we can bound, with room for what we cannot".
 */
const COMPLETION_ATTEMPTS = 360
const COMPLETION_PAUSE_SECONDS = 5

export const TERMINAL_SSM_STATUSES = new Set(['Success', 'Failed', 'Cancelled', 'TimedOut'])

/**
 * SendCommand is rejected with InvalidInstanceId until the instance's SSM agent
 * registers, and an instance reports `running` well before that. Throttling is
 * the other worth retrying: losing a roll to a rate limit would strand the fleet
 * half-upgraded. A bad id or a denied permission fails immediately.
 */
const RETRYABLE_SEND_ERRORS = /InvalidInstanceId|ThrottlingException|TooManyUpdates|RequestLimitExceeded/

/**
 * Which channel failures are worth another attempt.
 *
 * A tunnel that is not open yet is: a freshly created instance is not reachable
 * the moment the engine calls it created, and a newly granted OS Login profile
 * takes a moment to propagate. A permission that is simply absent is not — the
 * thirty-first attempt is refused exactly like the first, and retrying buries
 * the one line that says what to grant.
 */
const RETRYABLE_SESSION_ERRORS = /Connection refused|Connection timed out|Connection closed|not yet ready|Could not SSH|kex_exchange_identification|Broken pipe/i

/** ssh's own exit status for "could not establish the session". Always retryable. */
const SSH_CONNECT_FAILURE = 255

export type CommandResult = { ok: boolean; status: number | null; stdout: string; stderr: string }
export type RunCommand = (file: string, args: string[]) => CommandResult

/**
 * The CLI runner, with the environment the credentials live in.
 *
 * Taken rather than inherited because there are two callers with different
 * answers: the command the stack creates runs inside the engine, which already
 * holds the session, while `runner-update.ts` is a person's tool that has to be
 * handed the one mstage resolved.
 */
export const spawnWith =
  (environment: NodeJS.ProcessEnv = process.env): RunCommand =>
  (file, args) => {
    const result = spawnSync(file, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: environment })
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') throw new Error(`the \`${file}\` CLI is required but was not found on PATH`)
      throw new Error(`could not launch ${file}: ${result.error.message}`)
    }
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: (result.stdout || '').trim(),
      stderr: (result.stderr || '').trim(),
    }
  }

/** Blocking on purpose: one host at a time, so there is nothing to interleave. */
export const sleepSeconds = (seconds: number): void => {
  spawnSync('sleep', [String(seconds)])
}

/**
 * One host, named the way its cloud names one.
 *
 * A discriminated union rather than an options bag with everything optional:
 * an AWS roll needs a region and a GCP one needs a project and a zone, and a
 * shape that let either be missing would be a run that failed on the host after
 * the payload had been accepted.
 */
export type UpgradeOneRequest = {
  /** What the host should be serving when this returns. For the log and the SSM comment. */
  identity: string
  /** The script, base64-encoded. */
  payload: string
  /** The host as the control plane knows it, for the log. */
  label?: string
} & (
  | { cloud: 'aws'; target: string; region: string }
  | { cloud: 'gcp'; target: string; project: string; zone: string }
)

export type UpgradeContext = {
  run?: RunCommand
  sleep?: (seconds: number) => void
  log?: (line: string) => void
}

const required = (environment: NodeJS.ProcessEnv, key: string): string => {
  const value = environment[key]?.trim()
  if (!value) throw new Error(`${key} is required to upgrade a runner in place`)
  return value
}

const indent = (text: string): string =>
  text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')

/**
 * SSM: accept the command, then poll to a terminal status.
 *
 * `aws ssm wait command-executed` is deliberately not used. It gives up after
 * 100s and treats InProgress as retryable, so on a host whose upgrade
 * legitimately runs longer it returns with the command still running — and
 * reading that as a verdict would abort the roll on a host that is upgrading
 * fine.
 */
const upgradeOverSsm = ({
  target,
  identity,
  payload,
  region,
  run,
  sleep,
  log,
}: {
  target: string
  identity: string
  payload: string
  region: string
  run: RunCommand
  sleep: (seconds: number) => void
  log: (line: string) => void
}): number => {
  const send = [
    'ssm',
    'send-command',
    '--region',
    region,
    '--document-name',
    'AWS-RunShellScript',
    '--instance-ids',
    target,
    '--comment',
    `boxlite-runner upgrade to ${identity}`,
    '--parameters',
    `commands=["echo ${payload} | base64 -d | bash"]`,
    '--query',
    'Command.CommandId',
    '--output',
    'text',
  ]

  let commandId = ''
  for (let attempt = 1; ; attempt++) {
    const sent = run('aws', send)
    if (sent.ok) {
      commandId = sent.stdout
      break
    }
    if (!RETRYABLE_SEND_ERRORS.test(sent.stderr) || attempt >= CONNECT_ATTEMPTS) {
      throw new Error(`aws ssm send-command failed for ${target}: ${sent.stderr || '(no stderr)'}`)
    }
    log(`    ${target} not accepted yet (${attempt}/${CONNECT_ATTEMPTS}); retrying`)
    sleep(CONNECT_PAUSE_SECONDS)
  }
  log(`    command:  ${commandId}`)

  const invocation = [
    'ssm',
    'get-command-invocation',
    '--region',
    region,
    '--command-id',
    commandId,
    '--instance-id',
    target,
  ]
  // A poll can legitimately fail for a moment — InvocationDoesNotExist is normal
  // right after send-command — so one failure is not fatal. But the cause has to
  // survive: a persistent AccessDeniedException otherwise looks identical to a
  // slow upgrade and would be reported as a timeout naming nothing.
  let lastFailure = ''
  let lastStatus = ''
  let terminal = ''
  for (let attempt = 1; attempt <= COMPLETION_ATTEMPTS; attempt++) {
    const polled = run('aws', [...invocation, '--query', 'Status', '--output', 'text'])
    if (polled.ok) {
      if (TERMINAL_SSM_STATUSES.has(polled.stdout)) {
        terminal = polled.stdout
        break
      }
      lastStatus = polled.stdout
      // Cleared on recovery, or a stale InvocationDoesNotExist would outrank a
      // whole window of later InProgress polls and blame a resolved failure.
      lastFailure = ''
    } else {
      lastFailure = polled.stderr || '(no stderr)'
    }
    if (attempt < COMPLETION_ATTEMPTS) sleep(COMPLETION_PAUSE_SECONDS)
  }
  if (!terminal) {
    const why = lastFailure ? `last polling error: ${lastFailure}` : `last status: ${lastStatus || 'unknown'}`
    const minutes = (COMPLETION_ATTEMPTS * COMPLETION_PAUSE_SECONDS) / 60
    throw new Error(`${target}: the SSM command was still not terminal after ${minutes} minutes (${why})`)
  }

  // Both streams, because the payload's own diagnosis is the reason to read
  // them at all: a rollback writes why it rolled back to stderr.
  for (const query of ['StandardOutputContent', 'StandardErrorContent']) {
    const read = run('aws', [...invocation, '--query', query, '--output', 'text'])
    if (read.ok && read.stdout) log(indent(read.stdout))
  }
  if (terminal !== 'Success') throw new Error(`${target}: the SSM command ${commandId} finished ${terminal}`)
  return 0
}

/**
 * IAP: one tunnelled ssh, whose remote exit status is the verdict.
 *
 * `--quiet` so gcloud mints a key rather than asking, and no host key is
 * pinned — the tunnel is the authenticated channel and there is no long-lived
 * host identity to trust: a replaced host would present a new one and the roll
 * would stop on a prompt nobody can answer.
 */
const upgradeOverIap = ({
  target,
  payload,
  project,
  zone,
  run,
  sleep,
  log,
}: {
  target: string
  payload: string
  project: string
  zone: string
  run: RunCommand
  sleep: (seconds: number) => void
  log: (line: string) => void
}): number => {
  const args = [
    'compute',
    'ssh',
    target,
    `--project=${project}`,
    `--zone=${zone}`,
    '--tunnel-through-iap',
    '--quiet',
    '--ssh-flag=-oConnectTimeout=10',
    '--ssh-flag=-oStrictHostKeyChecking=no',
    '--ssh-flag=-oUserKnownHostsFile=/dev/null',
    '--command',
    `echo ${payload} | base64 -d | sudo bash`,
  ]
  for (let attempt = 1; ; attempt++) {
    const session = run('gcloud', args)
    if (session.stdout) log(indent(session.stdout))
    if (session.ok) return 0

    /*
     * Which of the two failed: the runner, or the way in.
     *
     * The payload announces itself on its first line, so its absence means
     * nothing ran on the host — see `ON_HOST` in `stack/runner-upgrade.ts` for
     * the failure that made an exit code an unusable discriminant.
     */
    if (session.stdout.includes(ON_HOST)) {
      // The payload's own refusal. Its stderr is the diagnosis.
      if (session.stderr) log(indent(session.stderr))
      throw new Error(`${target}: the upgrade payload exited ${session.status}`)
    }

    const reason = session.stderr || '(no stderr)'
    const retryable = session.status === SSH_CONNECT_FAILURE || RETRYABLE_SESSION_ERRORS.test(session.stderr)
    if (!retryable) {
      if (session.stderr) log(indent(session.stderr))
      throw new Error(
        `${target}: never reached the host — gcloud refused to open the session and retrying will not change that. ` +
          `Nothing on this runner was touched. gcloud said: ${reason}`,
      )
    }
    if (attempt >= CONNECT_ATTEMPTS) {
      throw new Error(
        `${target}: never reached the host — no IAP session after ${CONNECT_ATTEMPTS} attempts. ` +
          `Nothing on this runner was touched. gcloud said: ${reason}`,
      )
    }
    log(`    ${target} not reachable over IAP yet (${attempt}/${CONNECT_ATTEMPTS}); retrying`)
    sleep(CONNECT_PAUSE_SECONDS)
  }
}

/** The payload reaches a shell verbatim, inside another command line. */
const assertEncoded = (payload: string): string => {
  if (!/^[A-Za-z0-9+/=]+$/.test(payload)) {
    throw new Error('the payload must be the base64 the stack encoded, and reaches a shell verbatim')
  }
  return payload
}

/**
 * One host's roll, over whichever channel its cloud offers.
 *
 * The one entry point both callers share: the `UpgradeRunnerBinary*` command
 * each provider creates, and `runner-update.ts` walking a fleet by hand. Sharing
 * it is what stops the out-of-band tool from becoming a second, laxer
 * implementation of the thing the deploy does — the payload, the retries and
 * the verdict are the same either way.
 */
export const upgradeOne = (
  request: UpgradeOneRequest,
  { run = spawnWith(), sleep = sleepSeconds, log = console.log }: UpgradeContext = {},
): number => {
  const payload = assertEncoded(request.payload)
  log(`==> ${request.label ?? request.target} (${request.target}) → ${request.identity}`)
  switch (request.cloud) {
    case 'aws':
      return upgradeOverSsm({
        target: request.target,
        identity: request.identity,
        payload,
        region: request.region,
        run,
        sleep,
        log,
      })
    case 'gcp':
      return upgradeOverIap({
        target: request.target,
        payload,
        project: request.project,
        zone: request.zone,
        run,
        sleep,
        log,
      })
  }
}

/**
 * The same, read out of the environment.
 *
 * The shape the engine can hand over: a `local.Command` carries an environment
 * and nothing else, so this is the adapter between that and the request above.
 */
export const upgradeRunner = ({
  environment,
  ...context
}: { environment: NodeJS.ProcessEnv } & UpgradeContext): number => {
  const cloud = required(environment, 'RUNNER_UPGRADE_CLOUD')
  const common = {
    target: required(environment, 'RUNNER_UPGRADE_TARGET'),
    identity: required(environment, 'RUNNER_UPGRADE_IDENTITY'),
    payload: required(environment, 'RUNNER_UPGRADE_PAYLOAD'),
    label: environment.RUNNER_UPGRADE_LABEL?.trim() || undefined,
  }
  switch (cloud) {
    case 'aws':
      return upgradeOne({ ...common, cloud, region: required(environment, 'AWS_REGION') }, context)
    case 'gcp':
      return upgradeOne(
        {
          ...common,
          cloud,
          project: required(environment, 'GCP_PROJECT'),
          zone: required(environment, 'GCP_ZONE'),
        },
        context,
      )
    default:
      throw new Error(`RUNNER_UPGRADE_CLOUD must be "aws" or "gcp"; got ${JSON.stringify(cloud)}`)
  }
}

export const runUpgradeRunnerCli = (): void => {
  try {
    process.exitCode = upgradeRunner({ environment: process.env })
  } catch (error) {
    console.error(`upgrade-runner-binary: ${(error as Error).message}`)
    process.exitCode = 1
  }
}
