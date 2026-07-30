// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Run an `sst` command with the Cloudflare provider credentials loaded.
 *
 * The Cloudflare provider initializes inside `app()` (sst.config.ts), before
 * `run()` exists — so its credentials can't be `sst.Secret` like the app
 * secrets. They live in AWS SSM Parameter Store (SecureString) instead, keyed
 * per stage, and this wrapper fetches + exports them just before invoking sst.
 * App secrets are NOT handled here; sst resolves those from its own store.
 *
 * Wired into the dev/deploy/remove npm scripts, plus a passthrough:
 *   npm run deploy -- --stage dev      → node sst-with-cloudflare.mjs deploy --stage dev
 *   npm run sst -- diff --stage dev     → any other subcommand
 * A successful deploy is followed by a read-only AWS check that the Proxy NLB
 * listener, ECS target-group attachment, and healthy targets agree.
 *
 * One access gate: a deployer already needs AWS credentials to deploy, so the
 * same credentials fetch the Cloudflare token from SSM — nothing extra to share.
 *
 * Seed the parameters once per stage:
 *   aws ssm put-parameter --region ap-southeast-1 --type SecureString \
 *     --name /boxlite/<stage>/cloudflare-api-token   --value "<token>"
 *   aws ssm put-parameter --region ap-southeast-1 --type SecureString \
 *     --name /boxlite/<stage>/cloudflare-account-id  --value "<account-id>"
 *
 * A credential already in the environment is used as-is (works offline / before
 * the params are seeded). Missing creds are a warning, not a hard stop: commands
 * that don't touch Cloudflare (e.g. `unlock`) still run, and sst surfaces its own
 * error for one that does.
 */

import { execFileSync, spawn } from 'node:child_process'
import { constants as osConstants } from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  loadDeploymentEnvironment,
  readWorkspaceVersion,
  resolveAwsRegion,
  resolvePublicDeploymentConfig,
} from './deployment-environment.mjs'
import {
  resolveAwsCliPath,
  verifyProxyDeploymentWithRetry,
  verifyPublicDeploymentWithRetry,
} from './proxy-deployment-verify.mjs'
import { verifyRunnerReleaseAssets } from './runner-release-assets.mjs'
import { isSstComponentExcluded, resolveSstStage } from './sst-stage.mjs'
import { removePulumiEventLogs, withPulumiEventLogCleanup } from './sst-event-log-security.mjs'

const APP = 'boxlite'
const PULUMI_EVENT_LOG_ROOT = fileURLToPath(new URL('../.sst/pulumi', import.meta.url))
const CHILD_TERMINATION_GRACE_MS = 10_000
const TERMINATION_SIGNALS = ['SIGINT', 'SIGTERM']

let activeSstChild
let childTerminationTimer
let terminationSignal

function signalExitCode(signal) {
  return 128 + (osConstants.signals[signal] ?? 0)
}

function signalActiveSstChild(signal) {
  if (!activeSstChild || activeSstChild.exitCode !== null || activeSstChild.signalCode !== null) return
  activeSstChild.kill(signal)
  if (childTerminationTimer) return

  childTerminationTimer = setTimeout(() => {
    if (activeSstChild && activeSstChild.exitCode === null && activeSstChild.signalCode === null) {
      activeSstChild.kill('SIGKILL')
    }
  }, CHILD_TERMINATION_GRACE_MS)
  childTerminationTimer.unref()
}

for (const signal of TERMINATION_SIGNALS) {
  process.on(signal, () => {
    if (terminationSignal) {
      signalActiveSstChild('SIGKILL')
      return
    }
    terminationSignal = signal
    signalActiveSstChild(signal)
  })
}

// Delete stale streams before any blocking credential lookup. Signal handlers
// are already installed, so later cleanup cannot be bypassed by SIGINT/SIGTERM.
try {
  await removePulumiEventLogs(PULUMI_EVENT_LOG_ROOT)
} catch (error) {
  console.error(`sst-with-cloudflare: secure event-log cleanup failed: ${error.message}`)
  process.exit(1)
}

loadDeploymentEnvironment()

const REGION = resolveAwsRegion()

// SSM param consulted only when the matching env var is unset.
const CREDS = [
  { env: 'CLOUDFLARE_API_TOKEN', param: 'cloudflare-api-token' },
  { env: 'CLOUDFLARE_DEFAULT_ACCOUNT_ID', param: 'cloudflare-account-id' },
]

const sstArgs = process.argv.slice(2)
if (sstArgs.length === 0) {
  console.error('sst-with-cloudflare: expected an sst subcommand (e.g. "deploy --stage dev")')
  process.exit(1)
}

function fetchFromSsm(name) {
  try {
    const awsCliPath = resolveAwsCliPath()
    const out = execFileSync(
      awsCliPath,
      [
        'ssm',
        'get-parameter',
        '--region',
        REGION,
        '--name',
        name,
        '--with-decryption',
        '--query',
        'Parameter.Value',
        '--output',
        'text',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, killSignal: 'SIGTERM' },
    ).trim()
    return out && out !== 'None' ? out : null
  } catch (err) {
    if (err.code === 'ENOENT') console.warn('sst-with-cloudflare: `aws` CLI not found; skipping SSM lookup')
    return null // ParameterNotFound / auth error → warn below and let sst decide
  }
}

let stage
try {
  stage = resolveSstStage(sstArgs)
} catch (error) {
  console.error(`sst-with-cloudflare: ${error.message}`)
  process.exit(1)
}

for (const { env, param } of CREDS) {
  if (process.env[env]) continue // already provided — don't touch
  const name = `/boxlite/${stage}/${param}`
  const value = fetchFromSsm(name)
  if (value) {
    process.env[env] = value
  } else {
    console.warn(
      `sst-with-cloudflare: ${env} not in env and ${name} not in SSM (${REGION}); ` +
        `seed it with: aws ssm put-parameter --region ${REGION} --type SecureString --name ${name} --value <...>`,
    )
  }
}

async function runSstCommand() {
  if (terminationSignal) return signalExitCode(terminationSignal)

  // node_modules/.bin is on PATH because this runs via `npm run`, so `sst` resolves.
  return new Promise((resolve) => {
    let isSettled = false
    const settle = (exitCode) => {
      if (isSettled) return
      isSettled = true
      activeSstChild = undefined
      if (childTerminationTimer) clearTimeout(childTerminationTimer)
      childTerminationTimer = undefined
      resolve(terminationSignal ? signalExitCode(terminationSignal) : exitCode)
    }

    activeSstChild = spawn('sst', sstArgs, { stdio: 'inherit', env: process.env })
    activeSstChild.once('error', (error) => {
      console.error(`sst-with-cloudflare: failed to launch sst: ${error.message}`)
      settle(1)
    })
    activeSstChild.once('exit', (code, signal) => {
      settle(code ?? (signal ? signalExitCode(signal) : 1))
    })

    // A signal may arrive after the early check but before spawn returns.
    if (terminationSignal) signalActiveSstChild(terminationSignal)
  })
}

let publicDeploymentConfig
if (sstArgs[0] === 'deploy') {
  try {
    resolveAwsCliPath()
    const workspaceVersion = readWorkspaceVersion()
    publicDeploymentConfig = resolvePublicDeploymentConfig(process.env, workspaceVersion)
    if (isSstComponentExcluded(sstArgs, 'Runner')) {
      console.warn(
        `sst-with-cloudflare: Runner excluded; skipping the v${workspaceVersion} release-asset preflight. ` +
          'Runner metadata and new Runner-only capabilities will remain unavailable until a later full rollout.',
      )
    } else {
      await verifyRunnerReleaseAssets(workspaceVersion)
      console.log(`sst-with-cloudflare: Runner release assets verified (v${workspaceVersion}, linux-amd64)`)
    }
  } catch (error) {
    console.error(`sst-with-cloudflare: deployment preflight failed: ${error.message}`)
    process.exit(1)
  }
}

let exitCode
try {
  exitCode = await withPulumiEventLogCleanup(PULUMI_EVENT_LOG_ROOT, runSstCommand)
} catch (error) {
  console.error(`sst-with-cloudflare: secure event-log cleanup failed: ${error.message}`)
  exitCode = 1
}

if (exitCode === 0 && !terminationSignal && sstArgs[0] === 'deploy') {
  try {
    const verification = await verifyProxyDeploymentWithRetry(
      { app: APP, stage, region: REGION },
      {
        onRetry({ error, nextAttempt, attempts, delayMs }) {
          console.warn(
            `sst-with-cloudflare: Proxy routing is not ready (${error.message}); ` +
              `retrying ${nextAttempt}/${attempts} in ${delayMs / 1_000}s`,
          )
        },
      },
    )
    console.log(
      `sst-with-cloudflare: Proxy routing verified ` +
        `(${verification.healthyTargetCount}/${verification.desiredCount} healthy, ` +
        `listener → ${verification.targetGroupArn})`,
    )

    const publicVerification = await verifyPublicDeploymentWithRetry(publicDeploymentConfig, {
      onRetry({ error, nextAttempt, attempts, delayMs }) {
        console.warn(
          `sst-with-cloudflare: public deployment is not ready (${error.message}); ` +
            `retrying ${nextAttempt}/${attempts} in ${delayMs / 1_000}s`,
        )
      },
    })
    console.log(
      `sst-with-cloudflare: public deployment verified ` +
        `(Proxy ${publicVerification.proxyHealthUrl}, wildcard ${publicVerification.proxyWildcardHealthUrl}, ` +
        `API ${publicVerification.apiConfigUrl}, ` +
        `version ${publicVerification.version}, issuer ${publicVerification.oidcIssuer})`,
    )
  } catch (error) {
    console.error(`sst-with-cloudflare: SST deploy completed, but deployment verification failed: ${error.message}`)
    exitCode = 1
  }
}

if (terminationSignal) exitCode = signalExitCode(terminationSignal)
process.exit(exitCode)
