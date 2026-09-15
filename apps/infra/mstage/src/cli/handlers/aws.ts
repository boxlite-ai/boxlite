/**
 * `mstage aws` — everything about which identity a stage resolves to.
 *
 * `exec` is the compatibility bridge: it hands the resolved identity to an
 * existing tool rather than replacing it, so anything that reads credentials
 * from the environment keeps working while mstage takes over credential
 * resolution. Which tools a repository runs through it is that repository's
 * decision — mstage obtains access and never names what it is spent on.
 *
 * Nothing here is AWS-specific any more; the name is only the command's.
 * `resolveHome` picks the cloud once and answers with an `Identity`, and asking
 * again down here re-decides a settled question — on a GCP stage that produced
 * `identity.credentials is not a function` and an `arn` of `undefined`.
 */

import { spawn } from 'node:child_process'
import { runChild } from '../../aws/child-env.ts'
import type { Identity } from '../../identity.ts'
import type { Scope } from '../../aws/precedence.ts'

type Log = (line: string) => void

const pad = (key: string) => `${key}:`.padEnd(14)

export const printScope = (scope: Scope, log: Log): void => {
  log(`${pad('stage')}${scope.stage} (${scope.stageSource})`)
  log(`${pad('app')}${scope.app} (${scope.appSource})`)
  log(`${pad('region')}${scope.region} (${scope.regionSource})`)
  if (scope.roleArn) log(`${pad('assume role')}${scope.roleArn} (${scope.roleArnSource})`)
}

/**
 * What each cloud calls the two halves of a `Caller`, and what "no deadline"
 * means there. `identity.ts` names them `tenant` and `principal` so this reads
 * on either cloud; printing `account` and `arn` regardless labelled a GCP
 * project as an AWS account. A null expiry is likewise static credentials on
 * one cloud and self-refreshing ones on the other.
 */
const LABELS: Record<string, { tenant: string; principal: string; noExpiry: string }> = {
  aws: { tenant: 'account', principal: 'arn', noExpiry: 'never (long-lived credentials)' },
  gcp: { tenant: 'project', principal: 'principal', noExpiry: 'never (these credentials refresh themselves)' },
}

/**
 * Refused rather than given generic words, as `resolveHome` refuses a cloud it
 * has no backend for: a neutral fallback is a third vocabulary for a cloud that
 * does not exist.
 */
const labelsFor = (home: string) => {
  const labels = LABELS[home]
  if (!labels) throw new Error(`Unknown home "${home}"; mstage names a tenant and a principal on aws or gcp`)
  return labels
}

export const whoami = async ({ scope, identity, log }: { scope: Scope; identity: Identity; log: Log }) => {
  const caller = await identity.whoami()
  const expiresAt = await identity.expiresAt()
  const labels = labelsFor(identity.home)
  printScope(scope, log)
  log(`${pad(labels.tenant)}${caller.tenant ?? '(none reported)'}`)
  // Absent rather than empty: application default credentials carry no
  // `client_email`, so a GCP stage genuinely has no principal to name, and
  // printing the word `undefined` reads as a lookup that broke.
  log(`${pad(labels.principal)}${caller.principal ?? '(none; these credentials name no principal)'}`)
  log(`${pad('expires')}${expiresAt ? expiresAt.toISOString() : labels.noExpiry}`)
}

export const region = async ({ scope, log }: { scope: Scope; log: Log }) => {
  log(`${scope.region}`)
  log(`# resolved from ${scope.regionSource}`)
}

/** Runs another command under the resolved identity, so existing tools keep working unchanged. */
export const exec = async ({
  identity,
  inner,
  log,
  spawnProcess = spawn,
}: {
  identity: Identity
  inner: string[] | null
  log: Log
  spawnProcess?: any
}) => {
  if (!inner || inner.length === 0) {
    throw new Error('usage: npm run mstage aws exec -- --stage <stage> -- <command> [args…]')
  }
  // The identity builds it. Each cloud hands a child a different thing — a key
  // triple that does not refresh, or a project and a path to credentials that
  // do — and `Identity.childEnvironment` is where that difference already lives.
  const { env, expiresAt } = await identity.childEnvironment()
  if (expiresAt) log(`# credentials expire at ${expiresAt.toISOString()}; the child cannot refresh them`)
  const [command, ...args] = inner as string[]
  return runChild({ command: command!, args, env, spawnProcess })
}
