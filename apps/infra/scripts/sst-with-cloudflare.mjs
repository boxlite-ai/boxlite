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
 * Stack-evaluating commands always replace ambient values with the exact
 * stage-scoped SSM SecureStrings. Commands that do not evaluate the stack do
 * not retrieve provider credentials.
 */

import { execFileSync, spawn } from 'node:child_process'
import { constants as osConstants, devNull } from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  readWorkspaceVersion,
  resolveAwsRegion,
  resolvePublicDeploymentConfig,
} from './deployment-environment.mjs'
import { resolveAndInjectDeploymentConfig } from './deployment-config-loader.mjs'
import {
  DEPLOYMENT_OPERATION_LOCK_OWNER_ENV,
  DeploymentConfigStore,
} from './deployment-config-store.mjs'
import { DEPLOYMENT_CONFIG_REGISTRY, shieldSstEnvironment } from './deployment-config.mjs'
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
import { classifySstCommand } from './sst-command-contract.mjs'
import {
  assertNoSstStageEnvironmentFile,
  assertSstBaseEnvironmentIsClassified,
} from './sst-native-environment.mjs'
import { SstSecretStatusStore, resolveTrackedSstSecretMutation } from './sst-secret-status.mjs'
import { resolveSstStage } from './sst-stage.mjs'
import { assertRuntimeSecretGenerationsCurrent } from './runtime-secret-generation-guard.mjs'
import {
  prepareSstLogSecurity,
  removePulumiEventLogs,
  withPulumiEventLogCleanup,
  withSstLogSecurity,
} from './sst-event-log-security.mjs'

const APP = 'boxlite'
const INFRA_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PULUMI_EVENT_LOG_ROOT = fileURLToPath(new URL('../.sst/pulumi', import.meta.url))
const TERMINATION_SIGNALS = ['SIGINT', 'SIGTERM']
const CLASSIFIED_SST_ENVIRONMENT_NAMES = new Set(Object.keys(DEPLOYMENT_CONFIG_REGISTRY))

let terminationSignal
let artifactPreflightAbortController
let runnerStateBaselineAbortController
let deploymentVerificationAbortController
const sstProcessTerminator = new SstProcessTerminator()
let deploymentOperationLockStore
let deploymentOperationLock

function releaseDeploymentOperationLock() {
  if (!deploymentOperationLock) return
  const ownedLock = deploymentOperationLock
  deploymentOperationLockStore.releaseDeploymentOperationLock(ownedLock)
  deploymentOperationLock = undefined
}

// Every normal exit path is synchronous at this boundary, including the
// process.exit() calls used by early preflight failures. SIGKILL can still
// leave a stale lock; the acquisition error gives the deliberate recovery
// command and the README requires checking that no owner remains first.
process.on('exit', () => {
  try {
    releaseDeploymentOperationLock()
  } catch (error) {
    console.error(`sst-with-cloudflare: could not clean up the deployment operation lock: ${error.message}`)
  }
})

function signalExitCode(signal) {
  return 128 + (osConstants.signals[signal] ?? 0)
}

for (const signal of TERMINATION_SIGNALS) {
  process.on(signal, () => {
    const isRepeatedTermination = Boolean(terminationSignal)
    if (!terminationSignal) {
      terminationSignal = signal
      artifactPreflightAbortController?.abort(new Error(`Artifact preflight interrupted by ${signal}`))
      runnerStateBaselineAbortController?.abort(new Error(`Runner state baseline interrupted by ${signal}`))
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
  await prepareSstLogSecurity(INFRA_ROOT)
} catch (error) {
  console.error(`sst-with-cloudflare: secure log preparation failed: ${error.message}`)
  process.exit(1)
}
if (terminationSignal) process.exit(signalExitCode(terminationSignal))

let sstExecutable
try {
  sstExecutable = resolveSstExecutable()
} catch (error) {
  console.error(`sst-with-cloudflare: ${error.message}`)
  process.exit(1)
}

// Bootstrap-owned SSM parameters are authoritative for stack evaluation.
const CREDS = [
  { env: 'CLOUDFLARE_API_TOKEN', param: 'cloudflare-api-token' },
  { env: 'CLOUDFLARE_DEFAULT_ACCOUNT_ID', param: 'cloudflare-account-id' },
]

let sstArgs = process.argv.slice(2)
if (sstArgs.length === 0) {
  console.error('sst-with-cloudflare: expected an sst subcommand (e.g. "deploy --stage dev")')
  process.exit(1)
}
const sstEnvironment = { ...process.env }
let deployScope
let commandContract
let sstSecretMutation
try {
  commandContract = classifySstCommand(sstArgs)
  sstSecretMutation = resolveTrackedSstSecretMutation(sstArgs)
  if (sstSecretMutation) sstArgs = sstSecretMutation.sstArgs
  requireSstSubcommandFirst(sstArgs)
  deployScope = resolveDeployScope(sstArgs)
  // Before sst is spawned, and unconditionally: sst inherits this process's env, and an excluded
  // leg has to be absent from the resource graph as well as from the plan. `--exclude Runner`
  // omits the instance but not UpgradeRunnerBinary-*, a sibling command whose artifact trigger
  // moves with the deployed commit — left declared, it would install a Runner binary this run
  // deliberately never built.
  exportDeployScope(deployScope, sstEnvironment)
  sstArgs = withRequiredRunnerPolicy(sstArgs, INFRA_ROOT)
} catch (error) {
  console.error(`sst-with-cloudflare: ${error.message}`)
  process.exit(1)
}

function fetchRequiredProviderCredential(name, { awsCliPath, region }) {
  try {
    const out = execFileSync(
      awsCliPath,
      [
        'ssm',
        'get-parameter',
        '--region',
        region,
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
    if (!out || out === 'None') throw new Error('parameter returned no value')
    return out
  } catch {
    // AWS stderr and malformed output are untrusted and may contain provider
    // material. Keep the operator error names-only and discard the raw cause.
    throw new Error(`could not load required provider credential ${name} from SSM`)
  }
}

let stage
try {
  stage = resolveSstStage(sstArgs, sstEnvironment)
  if (sstSecretMutation && stage !== sstSecretMutation.stage) {
    throw new Error('validated SST secret mutation stage changed before execution')
  }
} catch (error) {
  console.error(`sst-with-cloudflare: ${error.message}`)
  process.exit(1)
}

shieldSstEnvironment(sstEnvironment)
try {
  assertSstBaseEnvironmentIsClassified({
    args: sstArgs,
    workingDirectory: INFRA_ROOT,
    classifiedNames: CLASSIFIED_SST_ENVIRONMENT_NAMES,
  })
  assertNoSstStageEnvironmentFile({ args: sstArgs, stage, workingDirectory: INFRA_ROOT })
} catch (error) {
  console.error(`sst-with-cloudflare: ${error.message}`)
  process.exit(1)
}

let region = resolveAwsRegion(sstEnvironment)
let awsCliPath
let deploymentConfigRelease
if (commandContract.needsDeploymentConfig) {
  try {
    awsCliPath = resolveAwsCliPath(sstEnvironment)
    deploymentConfigRelease = resolveAndInjectDeploymentConfig({
      stage,
      region,
      awsCliPath,
      environment: sstEnvironment,
    })
    region = deploymentConfigRelease.document.region
    console.error(`sst-with-cloudflare: deployment config ${deploymentConfigRelease.releaseId}`)
  } catch (error) {
    console.error(`sst-with-cloudflare: could not load deployment config: ${error.message}`)
    process.exit(1)
  }
}

// Native SST accepts executable, backend, logging, and runtime overrides under
// SST_*. Both the initial shield and deployment-config injection clear that
// whole namespace; restore only the stage chosen by this wrapper and the
// audited null diagnostic path after the last shield. Pinned SST passes
// SST_LOG directly to os.Create, so this must be the actual platform null
// device rather than a symbolic sentinel string. Pulumi's two fixed files are
// separately pinned to /dev/null.
sstEnvironment.SST_STAGE = stage
sstEnvironment.SST_LOG = devNull
sstEnvironment.BOXLITE_SST_INSTALL_PROVIDERS = commandContract.subcommand === 'install' ? '1' : ''

if (commandContract.needsDeploymentConfig) {
  try {
    deploymentOperationLockStore = new DeploymentConfigStore({ awsCliPath, region })
    deploymentOperationLock = deploymentOperationLockStore.acquireDeploymentOperationLock({ stage })
    sstEnvironment[DEPLOYMENT_OPERATION_LOCK_OWNER_ENV] = deploymentOperationLock.ownerId
    assertRuntimeSecretGenerationsCurrent({
      stage,
      region,
      awsCliPath,
      expectedGenerations: deploymentConfigRelease.document.values.BOXLITE_RUNTIME_SECRET_GENERATIONS,
    })
  } catch (error) {
    try {
      releaseDeploymentOperationLock()
    } catch (cleanupError) {
      console.error(`sst-with-cloudflare: could not clean up the deployment operation lock: ${cleanupError.message}`)
    }
    console.error(`sst-with-cloudflare: ${error.message}`)
    process.exit(1)
  }
}

let sstSecretStatusStore
if (sstSecretMutation) {
  try {
    awsCliPath ??= resolveAwsCliPath(sstEnvironment)
    sstSecretStatusStore = new SstSecretStatusStore({ awsCliPath, region })
    // A failed/interrupted SST mutation must never leave a stale definitive
    // state. Mark UNKNOWN before invoking SST, then finalize only on exit 0.
    sstSecretStatusStore.write({ stage, name: sstSecretMutation.name, status: 'UNKNOWN' })
  } catch (error) {
    console.error(`sst-with-cloudflare: ${error.message}`)
    process.exit(1)
  }
}

if (commandContract.needsProviderCredentials) {
  for (const { env, param } of CREDS) {
    const name = `/boxlite/${stage}/${param}`
    try {
      sstEnvironment[env] = fetchRequiredProviderCredential(name, { awsCliPath, region })
    } catch (error) {
      console.error(`sst-with-cloudflare: ${error.message}`)
      process.exit(1)
    }
  }
}
if (terminationSignal) process.exit(signalExitCode(terminationSignal))

async function runSstCommand() {
  if (terminationSignal) return signalExitCode(terminationSignal)
  try {
    assertSstBaseEnvironmentIsClassified({
      args: sstArgs,
      workingDirectory: INFRA_ROOT,
      classifiedNames: CLASSIFIED_SST_ENVIRONMENT_NAMES,
    })
    assertNoSstStageEnvironmentFile({ args: sstArgs, stage, workingDirectory: INFRA_ROOT })
  } catch (error) {
    console.error(`sst-with-cloudflare: ${error.message}`)
    return 1
  }

  // Run the native binary directly so this process can await SST's graceful
  // cancellation instead of losing it behind the JavaScript launcher shim.
  return new Promise((resolve) => {
    let isSettled = false
    const sstChild = spawn(sstExecutable, sstArgs, {
      stdio: sstSecretMutation ? ['inherit', 'ignore', 'ignore'] : 'inherit',
      cwd: INFRA_ROOT,
      env: sstEnvironment,
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
if (commandContract.subcommand === 'deploy') {
  artifactPreflightAbortController = new AbortController()
  try {
    resolveAwsCliPath(sstEnvironment)
    const workspaceVersion = readWorkspaceVersion()
    publicDeploymentConfig = resolvePublicDeploymentConfig(sstEnvironment, workspaceVersion)
    const signal = artifactPreflightAbortController.signal

    // Only what this deploy declares. A scope that excludes a component omits its resources from
    // the plan, so verifying its artifact would fail a complete deploy for a missing thing nobody
    // asked to deploy — an Api-only run deliberately never builds a Runner for that commit.
    // resolveDeployScope answers "in scope?" for both the guard and here, so the plan and the
    // preflight cannot disagree about what is being deployed.
    const apiSource = deployScope.components.includes('api')
      ? resolveArtifactSource('api', sstEnvironment)
      : undefined
    const runnerSource = deployScope.components.includes('runner')
      ? resolveArtifactSource('runner', sstEnvironment)
      : undefined
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
          region,
          version: apiSource.version,
          ref: apiSource.kind === 'release' ? undefined : apiSource.ref,
        },
        { awsCliPath: resolveAwsCliPath(sstEnvironment) },
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
              ...sstEnvironment,
              AWS_REGION: region,
              RUNNER_ARTIFACT_BUCKET: runnerArtifactsBucketName({
                app: APP,
                stage,
                accountId: await resolveAwsAccountId({ awsCliPath, environment: sstEnvironment, signal }),
              }),
            }
          : { ...sstEnvironment, AWS_REGION: region }
      const runnerArtifact = await verifyRunnerArtifact(runnerSource, {
        awsCliPath,
        environment: artifactEnvironment,
        signal,
      })
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
if (commandContract.needsRunnerStateBaseline) {
  runnerStateBaselineAbortController = new AbortController()
  try {
    assertSstBaseEnvironmentIsClassified({
      args: sstArgs,
      workingDirectory: INFRA_ROOT,
      classifiedNames: CLASSIFIED_SST_ENVIRONMENT_NAMES,
    })
    assertNoSstStageEnvironmentFile({ args: sstArgs, stage, workingDirectory: INFRA_ROOT })
    sstEnvironment.BOXLITE_RUNNER_STATE_BASELINE = await withSstLogSecurity(INFRA_ROOT, () =>
      readRunnerStateBaseline({
        stage,
        sstPath: sstExecutable,
        sstArgs,
        environment: sstEnvironment,
        signal: runnerStateBaselineAbortController.signal,
        workingDirectory: INFRA_ROOT,
      }),
    )
  } catch (error) {
    if (terminationSignal) process.exit(signalExitCode(terminationSignal))
    console.error(`sst-with-cloudflare: Runner state baseline failed: ${error.message}`)
    process.exit(1)
  } finally {
    runnerStateBaselineAbortController = undefined
  }
}

let exitCode
try {
  exitCode = await withSstLogSecurity(INFRA_ROOT, () =>
    withPulumiEventLogCleanup(PULUMI_EVENT_LOG_ROOT, runSstCommand),
  )
} catch (error) {
  console.error(`sst-with-cloudflare: secure log cleanup failed: ${error.message}`)
  exitCode = 1
}

if (exitCode === 0 && !terminationSignal && sstSecretMutation) {
  try {
    sstSecretStatusStore.write({
      stage,
      name: sstSecretMutation.name,
      status: sstSecretMutation.finalStatus,
    })
  } catch (error) {
    console.error(`sst-with-cloudflare: ${error.message}`)
    exitCode = 1
  }
}

if (exitCode === 0 && !terminationSignal && commandContract.subcommand === 'deploy') {
  deploymentVerificationAbortController = new AbortController()
  try {
    const verification = await verifyProxyDeploymentWithRetry(
      { app: APP, stage, region },
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
try {
  releaseDeploymentOperationLock()
} catch (error) {
  console.error(`sst-with-cloudflare: could not clean up the deployment operation lock: ${error.message}`)
  exitCode = 1
}
process.exit(exitCode)
