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
 * Wired into the deploy/remove npm scripts, plus a passthrough:
 *   npm run deploy -- --stage dev      → node sst-with-cloudflare.mjs deploy --stage dev
 *   npm run sst -- diff --stage dev    → any other subcommand
 * `sst dev` is disabled because one long-running process cannot keep its Runner
 * state baseline fresh for every update.
 * A successful deploy is followed by a read-only AWS check that the Proxy NLB
 * listener, ECS target-group attachment, and healthy targets agree.
 *
 * One access gate: a deployer already needs AWS credentials to deploy, so the
 * same credentials fetch the Cloudflare token from SSM — nothing extra to share.
 *
 * Seed the parameters once per stage with the README's non-echoing prompt and
 * `--value file:///dev/stdin`; never put credential values in process argv.
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
  exportDeployScope,
  resolveDeployScope,
  requireSstSubcommandFirst,
  withRequiredRunnerPolicy,
} from './deployment-scope.mjs'
import {
  resolveAwsCliPath,
  verifyProxyDeploymentWithRetry,
  verifyPublicDeploymentWithRetry,
} from './proxy-deployment-verify.mjs'
import { verifyApiImage } from './api-artifact.mjs'
import { requireCheckoutMatchesArtifactRefs, resolveArtifactSource } from './artifact-source.mjs'
import { resolveAwsAccountId, runnerArtifactsBucketName, verifyRunnerArtifact } from './runner-artifact.mjs'
import { readRunnerStateBaseline } from './runner-policy-baseline.mjs'
import { resolveSstExecutable } from './sst-executable.mjs'
import { SstProcessTerminator } from './sst-process-termination.mjs'
import { resolveSstStage } from './sst-stage.mjs'
import { removePulumiEventLogs, withPulumiEventLogCleanup } from './sst-event-log-security.mjs'

const APP = 'boxlite'
const PULUMI_EVENT_LOG_ROOT = fileURLToPath(new URL('../.sst/pulumi', import.meta.url))
const TERMINATION_SIGNALS = ['SIGINT', 'SIGTERM']

let terminationSignal
let artifactPreflightAbortController
let runnerPolicyPreflightAbortController
let deploymentVerificationAbortController
const sstProcessTerminator = new SstProcessTerminator()

function signalExitCode(signal) {
  return 128 + (osConstants.signals[signal] ?? 0)
}

for (const signal of TERMINATION_SIGNALS) {
  process.on(signal, () => {
    const isRepeatedTermination = Boolean(terminationSignal)
    if (!terminationSignal) {
      terminationSignal = signal
      artifactPreflightAbortController?.abort(new Error(`Artifact preflight interrupted by ${signal}`))
      runnerPolicyPreflightAbortController?.abort(new Error(`Runner policy preflight interrupted by ${signal}`))
      deploymentVerificationAbortController?.abort(new Error(`Deployment verification interrupted by ${signal}`))
    }
    if (isRepeatedTermination) {
      sstProcessTerminator.forceStop()
    } else {
      // Forward SIGTERM as SIGINT too so SST can cancel Pulumi cleanly.
      sstProcessTerminator.interrupt()
    }
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
if (terminationSignal) process.exit(signalExitCode(terminationSignal))

loadDeploymentEnvironment()

const REGION = resolveAwsRegion()
let sstExecutable
try {
  sstExecutable = resolveSstExecutable()
} catch (error) {
  console.error(`sst-with-cloudflare: ${error.message}`)
  process.exit(1)
}

// SSM param consulted only when the matching env var is unset.
const CREDS = [
  { env: 'CLOUDFLARE_API_TOKEN', param: 'cloudflare-api-token' },
  { env: 'CLOUDFLARE_DEFAULT_ACCOUNT_ID', param: 'cloudflare-account-id' },
]

let sstArgs = process.argv.slice(2)
if (sstArgs.length === 0) {
  console.error('sst-with-cloudflare: expected an sst subcommand (e.g. "deploy --stage dev")')
  process.exit(1)
}
let deployScope
try {
  requireSstSubcommandFirst(sstArgs)
  deployScope = resolveDeployScope(sstArgs)
  // Before sst is spawned, and unconditionally: sst inherits this process's env, and an excluded
  // leg has to be absent from the resource graph as well as from the plan. `--exclude Runner`
  // omits the instance but not UpgradeRunnerBinary-*, a sibling command whose artifact trigger
  // moves with the deployed commit — left declared, it would install a Runner binary this run
  // deliberately never built.
  exportDeployScope(deployScope)
  sstArgs = withRequiredRunnerPolicy(sstArgs)
} catch (error) {
  console.error(`sst-with-cloudflare: ${error.message}`)
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
        `seed it with the README's stdin-based aws ssm put-parameter procedure`,
    )
  }
}
if (terminationSignal) process.exit(signalExitCode(terminationSignal))

async function runSstCommand() {
  if (terminationSignal) return signalExitCode(terminationSignal)

  // Run the native binary directly so this process can await SST's graceful
  // cancellation instead of losing it behind the JavaScript launcher shim.
  return new Promise((resolve) => {
    let isSettled = false
    const sstChild = spawn(sstExecutable, sstArgs, {
      stdio: 'inherit',
      env: process.env,
      detached: process.platform !== 'win32',
    })
    sstProcessTerminator.attach(sstChild)

    const settle = (exitCode) => {
      if (isSettled) return
      isSettled = true
      sstProcessTerminator.settle(sstChild)
      resolve(terminationSignal ? signalExitCode(terminationSignal) : exitCode)
    }

    sstChild.once('error', (error) => {
      console.error(`sst-with-cloudflare: failed to launch sst: ${error.message}`)
      settle(1)
    })
    sstChild.once('exit', (code, signal) => {
      settle(code ?? (signal ? signalExitCode(signal) : 1))
    })

    // A signal may arrive after the early check but before spawn returns.
    if (terminationSignal) sstProcessTerminator.interrupt()
  })
}

let publicDeploymentConfig
if (sstArgs[0] === 'deploy') {
  artifactPreflightAbortController = new AbortController()
  try {
    resolveAwsCliPath()
    const workspaceVersion = readWorkspaceVersion()
    publicDeploymentConfig = resolvePublicDeploymentConfig(process.env, workspaceVersion)
    const signal = artifactPreflightAbortController.signal

    // Only what this deploy declares. A scope that excludes a component omits its resources from
    // the plan, so verifying its artifact would fail a complete deploy for a missing thing nobody
    // asked to deploy — an Api-only run deliberately never builds a Runner for that commit.
    // resolveDeployScope answers "in scope?" for both the guard and here, so the plan and the
    // preflight cannot disagree about what is being deployed.
    const apiSource = deployScope.components.includes('api') ? resolveArtifactSource('api') : undefined
    const runnerSource = deployScope.components.includes('runner') ? resolveArtifactSource('runner') : undefined
    // Across every component in scope, before any of them is verified. The Proxy and the
    // OtelCollector are built from this checkout on every path, so any ref that is not the
    // checkout deploys two commits — and nothing downstream would notice: the staged Runner object
    // still verifies and the post-deploy check only reads X.Y.Z. Checking one component's ref
    // would miss the deploy that addresses only the other, which is what
    // `npm run runner:build-artifact` produces. Out-of-scope entries are undefined and drop out.
    requireCheckoutMatchesArtifactRefs([apiSource, runnerSource])

    if (apiSource && (apiSource.kind === 'release' || apiSource.ref)) {
      const image = verifyApiImage(
        {
          app: APP,
          stage,
          region: REGION,
          version: apiSource.version,
          ref: apiSource.kind === 'release' ? undefined : apiSource.ref,
        },
        { awsCliPath: resolveAwsCliPath() },
      )
      console.log(
        `sst-with-cloudflare: Api ${apiSource.kind} image verified (${image.repository}:${image.tag}, ${image.digest})`,
      )
    }
    // Verify whichever artifact this deploy actually resolved to, not always the published
    // release: a build-mode deploy 404-ing on the host is the failure this preflight exists to
    // prevent, and it would sail straight through a release-only check.
    if (runnerSource) {
      const artifactEnvironment =
        runnerSource.kind === 'build'
          ? {
              ...process.env,
              RUNNER_ARTIFACT_BUCKET: runnerArtifactsBucketName({
                app: APP,
                stage,
                accountId: await resolveAwsAccountId({ signal }),
              }),
            }
          : process.env
      const runnerArtifact = await verifyRunnerArtifact(runnerSource, { environment: artifactEnvironment, signal })
      console.log(
        `sst-with-cloudflare: Runner ${runnerSource.kind} artifact verified (${runnerArtifact.tarballUrl}, linux-amd64)`,
      )
    }
    if (deployScope.excluded.length > 0) {
      console.log(
        `sst-with-cloudflare: ${deployScope.excluded.join(', ')} excluded from this deploy; artifact unverified`,
      )
    }
  } catch (error) {
    if (terminationSignal) process.exit(signalExitCode(terminationSignal))
    console.error(`sst-with-cloudflare: deployment preflight failed: ${error.message}`)
    process.exit(1)
  } finally {
    artifactPreflightAbortController = undefined
  }
}

if (terminationSignal) process.exit(signalExitCode(terminationSignal))
if (sstArgs[0] === 'diff' || sstArgs[0] === 'deploy') {
  runnerPolicyPreflightAbortController = new AbortController()
  try {
    process.env.BOXLITE_RUNNER_STATE_BASELINE = await readRunnerStateBaseline({
      stage,
      sstPath: sstExecutable,
      sstArgs,
      environment: process.env,
      signal: runnerPolicyPreflightAbortController.signal,
    })
  } catch (error) {
    if (terminationSignal) process.exit(signalExitCode(terminationSignal))
    console.error(`sst-with-cloudflare: Runner policy preflight failed: ${error.message}`)
    process.exit(1)
  } finally {
    runnerPolicyPreflightAbortController = undefined
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
  deploymentVerificationAbortController = new AbortController()
  try {
    const verification = await verifyProxyDeploymentWithRetry(
      { app: APP, stage, region: REGION },
      {
        signal: deploymentVerificationAbortController.signal,
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
      signal: deploymentVerificationAbortController.signal,
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
    if (!terminationSignal) {
      console.error(`sst-with-cloudflare: SST deploy completed, but deployment verification failed: ${error.message}`)
    }
    exitCode = 1
  } finally {
    deploymentVerificationAbortController = undefined
  }
}

if (terminationSignal) exitCode = signalExitCode(terminationSignal)
process.exit(exitCode)
