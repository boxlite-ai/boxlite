// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import policies from './bot-detection.json' with { type: 'json' }
import { Auth0ManagementCli, type PasswordChallengePolicy } from './management-cli.js'
import targets from './targets.json' with { type: 'json' }
import { parseTarget, type JsonObject } from './universal-login.js'

function isPasswordChallengePolicy(value: unknown): value is PasswordChallengePolicy {
  return value === 'never' || value === 'when_risky' || value === 'always'
}

function readPolicy(settings: JsonObject) {
  const policy = settings.challenge_password_policy
  const monitoring = settings.monitoring_mode_enabled
  if (!isPasswordChallengePolicy(policy) || typeof monitoring !== 'boolean') {
    throw new Error('Auth0 returned an invalid password challenge policy or monitoring flag')
  }
  return { policy, monitoring }
}

export async function runBotDetectionCommand(
  args: readonly string[],
  management = new Auth0ManagementCli(),
  write: (line: string) => void = console.log,
) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    write('Usage: npm run auth0:bot-detection -- <preview|apply> --stage <name>')
    return
  }
  const { positionals, values } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { stage: { type: 'string' } },
  })
  const action = positionals[0]
  if (positionals.length !== 1 || (action !== 'preview' && action !== 'apply')) {
    throw new Error('action must be preview or apply')
  }
  const stage = values.stage?.trim()
  if (!stage) throw new Error('--stage is required')
  const target = parseTarget(targets, stage)
  const desired = Object.hasOwn(policies, stage) ? (policies as Record<string, unknown>)[stage] : undefined
  if (!isPasswordChallengePolicy(desired)) {
    throw new Error(`stage '${stage}' needs a valid policy in auth0/bot-detection.json`)
  }

  const current = readPolicy(await management.getBotDetection(target))
  write(`Stage: ${stage} | Tenant: ${target.auth0TenantDomain}`)
  write(`Password challenge policy: ${current.policy} -> ${desired} | Monitoring mode: ${current.monitoring}`)
  if (action === 'preview') return
  if (desired !== 'never' && current.monitoring) {
    throw new Error('Auth0 is in monitoring mode, which prevents password challenge enforcement')
  }
  if (current.policy === desired) {
    write('Password challenge policy already matches.')
    return
  }

  try {
    await management.updatePasswordChallengePolicy(target, desired)
    const applied = readPolicy(await management.getBotDetection(target))
    if (applied.policy !== desired || (desired !== 'never' && applied.monitoring)) {
      throw new Error(`readback returned policy ${applied.policy} and monitoring mode ${applied.monitoring}`)
    }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`Auth0 apply could not be verified. Preview stage '${stage}' before retrying. ${detail}`, { cause })
  }
  write(`Verified Auth0 password challenge policy: ${desired}`)
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  await runBotDetectionCommand(process.argv.slice(2)).catch((cause: unknown) => {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exitCode = 1
  })
}
