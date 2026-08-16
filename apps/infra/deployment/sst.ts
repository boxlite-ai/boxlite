// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Run an `sst` command with the stage's configuration loaded.
 *
 * Values the deployed stack reads through `process.env` / `envOr()` — STACK_DOMAIN, the OIDC
 * settings, the feature toggles, and the Cloudflare provider credentials — cannot be `sst.Secret`:
 * the provider initializes inside `app()` (sst.config.ts) before `run()` exists, and an
 * Output<string> would break every string comparison and `new URL(...)` in stack/*.ts. So they live
 * in the stage's SST secret store as ordinary secrets, and this wrapper reads them back into
 * process.env just before invoking sst. See deployment/stage-config.ts for what may and may not
 * cross that boundary. The app secrets proper (OIDC_CLIENT_ID and friends) are NOT handled here;
 * sst resolves those itself through `sst.Secret`.
 *
 * That store replaced the GitHub Environment secret DEPLOY_ENV, which the deploy workflow used to
 * write out as apps/infra/.env for the length of a job. It is reachable by exactly the people who
 * can already deploy the stage, so local and CI deploys now resolve the same values from the
 * same place.
 *
 * The Cloudflare credentials are the one exception, and they cannot join it. Reading the store
 * initializes every provider `app()` declares, Cloudflare included — `sst secret list` fetches the
 * bootstrap state and then exits with "Cloudflare API not initialized" — so a token stored there
 * would be needed to read itself. They stay in AWS SSM (SecureString, per stage) and are fetched
 * below, before the store is read.
 *
 * The deploy workflow supplies them as Environment secrets rather than relying on this SSM copy.
 * Whether the scoped deploy role could read it is untested: it holds ssm:GetParameter and no
 * identity-based kms:Decrypt, but alias/aws/ssm is an AWS-managed key whose own key policy may admit
 * the account via kms:ViaService, and the role trusts only the GitHub OIDC principal so it cannot be
 * assumed locally to find out. The Environment secrets are what CI has always used; leave it that way
 * until someone measures the alternative from inside a job.
 *
 * Wired into the deploy/remove npm scripts, plus a passthrough:
 *   npm run deploy -- --stage dev      → tsx deployment/sst.ts deploy --stage dev
 *   npm run sst -- diff --stage dev    → any other subcommand
 * `sst dev` is disabled because one long-running process cannot keep its Runner
 * state baseline fresh for every update.
 * A successful deploy is followed by a read-only AWS check that the Proxy NLB
 * listener, ECS target-group attachment, and healthy targets agree.
 *
 * One access gate: a deployer already needs AWS credentials to deploy, and the same credentials
 * decrypt the store — nothing extra to share.
 *
 * A variable already in the environment is used as-is, never overridden by a stored value. That is
 * what keeps the deploy workflow in control of the selectors it sets itself, and it is the escape
 * hatch for a stored value that is wrong.
 *
 * A store that cannot be read stops every command that builds a plan — `diff` included. A preview
 * assembled from defaults is not a preview of the deploy that follows it: the operator approves that
 * plan, the apply then reads the store successfully, and reconciles something nobody reviewed.
 * Commands that need no configuration at all (`install`, `secret`, `unlock`) never read it.
 */

import { execFileSync, spawn } from 'node:child_process'
import { constants as osConstants } from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  SST_APP_NAME as APP,
  loadDeploymentEnvironment,
  readWorkspaceVersion,
  resolveAwsRegion,
  resolvePublicDeploymentConfig,
  resolveSstStage,
} from './environment.js'
import {
  exportDeployScope,
  resolveDeployScope,
  requireSstSubcommandFirst,
  withRequiredRunnerPolicy,
} from './scope.js'
import {
  STAGE_CONFIG_DIGEST_KEY,
  STAGE_CONFIG_MANIFEST_KEY,
  hydrateStageConfig,
  readStoredStageConfig,
} from './stage-config.js'
import { isLocalOnlyDeploymentKey } from './key-policy.js'
import {
  verifyProxyDeploymentWithRetry,
  verifyPublicDeploymentWithRetry,
} from './verify.js'
import { verifyApiImage } from '../artifacts/api.js'
import { requireCheckoutMatchesArtifactRefs, resolveArtifactSource } from '../artifacts/source.js'
import { resolveAwsAccountId, runnerArtifactsBucketName, verifyRunnerArtifact } from '../artifacts/runner.js'
import { readRunnerStateBaseline } from '../runner/policy-baseline.js'
import { resolveSstExecutable } from './sst-executable.js'
import { SstProcessTerminator } from './sst-process.js'
import { removePulumiEventLogs, withPulumiEventLogCleanup } from './pulumi-logs.js'
import { resolveAwsCliPath, runAwsText } from '../shared/exec.js'

const PULUMI_EVENT_LOG_ROOT = fileURLToPath(new URL('../.sst/pulumi', import.meta.url))
const TERMINATION_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']
/*
 * The subcommands that build a resource graph, and so the only ones that need the stage's
 * configuration. Everything else is deliberately excluded rather than merely harmless to include:
 * `install` and `secret` are what bootstrap itself runs, through this same wrapper, against a stage
 * whose store is still empty — hydrating there would warn on every line of a first-time bootstrap.
 */
const STAGE_CONFIG_SUBCOMMANDS = new Set(['deploy', 'diff', 'remove', 'refresh'])

let terminationSignal: any
let artifactPreflightAbortController: any
let runnerPolicyPreflightAbortController: any
let deploymentVerificationAbortController: any
const sstProcessTerminator = new SstProcessTerminator()

function signalExitCode(signal: NodeJS.Signals) {
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
} catch (error: any) {
  console.error(`sst-with-cloudflare: secure event-log cleanup failed: ${error.message}`)
  process.exit(1)
}
if (terminationSignal) process.exit(signalExitCode(terminationSignal))

/*
 * .env supplies ONLY the keys that must not become stage-wide configuration, which is exactly the set
 * isLocalOnlyDeploymentKey names — this machine's AWS_PROFILE / AWS_CLI_PATH, SST_STAGE, VERSION,
 * AWS_REGION, the Cloudflare pair, and the artifact selectors the deploy workflow owns. Deliberately
 * the predicate rather than a list repeated here: the two have to agree, and a hand-copied list is
 * what silently stops agreeing. Everything else in the file is ignored.
 *
 * The filter is the point, not a tidiness measure. A stored value is skipped when the variable is
 * already set (hydrateStageConfig), so loading the whole file first would let a stale local STACK_DOMAIN
 * silently beat the store and make a local deploy differ from CI — the exact divergence moving the
 * config into the store was meant to end. Editing .env now changes nothing until `npm run bootstrap`
 * reloads it, which is the intended trade.
 */
const localEnvironment: NodeJS.ProcessEnv = {}
loadDeploymentEnvironment({ environment: localEnvironment })
for (const [key, value] of Object.entries(localEnvironment)) {
  if (!isLocalOnlyDeploymentKey(key)) continue
  if (process.env[key] !== undefined) continue // a real environment variable still wins
  process.env[key] = value
}

// Resolved before the store is read, because the Cloudflare SSM lookup below needs it. AWS_REGION
// therefore has to come from the environment or .env — a value stored for it would arrive too late
// to steer this process, so stage-config.ts keeps it out of the store.
const REGION = resolveAwsRegion()

let sstExecutable: any
try {
  sstExecutable = resolveSstExecutable()
} catch (error: any) {
  console.error(`sst-with-cloudflare: ${error.message}`)
  process.exit(1)
}

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
} catch (error: any) {
  console.error(`sst-with-cloudflare: ${error.message}`)
  process.exit(1)
}

// SSM param consulted only when the matching env var is unset.
const CLOUDFLARE_CREDS = [
  { env: 'CLOUDFLARE_API_TOKEN', param: 'cloudflare-api-token' },
  { env: 'CLOUDFLARE_DEFAULT_ACCOUNT_ID', param: 'cloudflare-account-id' },
]

/*
 * The wrapper's own progress, on stderr.
 *
 * stdout belongs to the sst child, which this process spawns with `stdio: 'inherit'` — so anything
 * written here goes into the same stream, ahead of sst's output. `sst diff --json` is piped straight
 * into a JSON parser by the deploy workflow's preview step, and a progress line landing in that pipe
 * fails the parse on its first character rather than on anything about the plan.
 *
 * Named rather than `console.error` at each site: these are not errors, and the reason they avoid
 * stdout is not local to any one of them.
 */
function reportProgress(message: string) {
  console.error(message)
}

function fetchFromSsm(name: any) {
  try {
    const out = runAwsText(['ssm', 'get-parameter', '--name', name, '--with-decryption', '--query', 'Parameter.Value'], {
      region: REGION,
    })
    return out && out !== 'None' ? out : null
  } catch (err: any) {
    if (err.code === 'ENOENT') console.warn('sst-with-cloudflare: `aws` CLI not found; skipping SSM lookup')
    return null // ParameterNotFound / auth error → warn above and let sst decide
  }
}

/*
 * The stage's own sst binary, run for its stdout.
 *
 * Captured rather than inherited, because `secret list` prints every value it holds and this process
 * must not put those on the terminal or into a log. The resolved binary is called directly, never
 * back through this wrapper — that would recurse.
 */
function readSstStdout(args: string[]) {
  return execFileSync(sstExecutable, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    killSignal: 'SIGTERM',
  })
}

// Names only, for a refusal message. '(nothing)' rather than an empty string so the message reads as
// a sentence when the manifest is present but blank.
function manifestNames(stored: any) {
  const names = String(stored?.[STAGE_CONFIG_MANIFEST_KEY] ?? '').trim()
  return names === '' ? '(nothing)' : names
}

/*
 * Load the stage's configuration into process.env, which sst inherits.
 *
 * Every shape the store can be in that is not usable stops the command instead of falling back to the
 * environment as it stands: unreadable, no manifest, a digest that does not match its values, a
 * manifest naming a value the store lacks, and one that applies nothing. Defaults are not a safe
 * substitute for a stage's configuration now that the store is its only source — a deploy would
 * reconcile the stage to something nobody wrote, and report success.
 *
 * Commands that build no resource graph never get here (STAGE_CONFIG_SUBCOMMANDS), which is what lets
 * bootstrap run `install` and `secret load` through this same wrapper against a store that is still
 * empty. On a fresh stage the cause of a refusal is usually just that: nothing has seeded it yet, so
 * every message names the command that does.
 */
function loadStageConfig(stage: string) {
  if (!STAGE_CONFIG_SUBCOMMANDS.has(sstArgs[0])) return

  let stored
  try {
    stored = readStoredStageConfig({ app: APP, stage, runSst: readSstStdout })
  } catch (error: any) {
    // Deliberately not `error.message`: execFileSync builds it from the failed command line and the
    // captured stdio, which for `secret list` is the store's contents. Only the exit status is safe to
    // repeat, and it is enough to tell "never bootstrapped" from "cannot reach AWS".
    const status = error?.status ?? error?.code ?? 'unknown'
    const advice =
      `could not read the ${stage} stage configuration from the SST secret store (sst exited ${status}); ` +
      `seed it with \`npm run bootstrap -- --stage ${stage}\``
    // `diff` stops as well, even though it only reads. A preview built from defaults is not a preview
    // of the deploy that follows: the operator approves that plan, the apply then reads the store
    // successfully, and reconciles something nobody reviewed. Divergence between the two is the exact
    // failure the guarded preview exists to prevent, so an unreadable store fails both or neither.
    console.error(`sst-with-cloudflare: ${advice}`)
    process.exit(1)
  }

  // A store that reads cleanly but names nothing is not "no configuration to apply" — it is a stage
  // that was never bootstrapped, or one whose manifest was removed. Hydration would then be a no-op
  // and the deploy would reconcile against whatever the defaults happen to be, which is the same
  // outcome as an unreadable store and gets the same answer.
  if (!stored[STAGE_CONFIG_MANIFEST_KEY]?.trim()) {
    const advice =
      `the ${stage} stage configuration store has no ${STAGE_CONFIG_MANIFEST_KEY} manifest, so nothing ` +
      `can be applied from it; seed it with \`npm run bootstrap -- --stage ${stage}\``
    console.error(`sst-with-cloudflare: ${advice}`)
    process.exit(1)
  }

  const { apply, alreadySet, unlisted, missing, recordedDigest, actualDigest } = hydrateStageConfig({ stored })
  // A `secret load` that was interrupted leaves some keys new and some old, with every manifest name
  // still present — undetectable from the manifest alone, and it would deploy a configuration that
  // never existed as a whole.
  //
  // A missing digest is that same failure, not a store from an older bootstrap: the manifest and the
  // digest go into one `secret load`, and no released bootstrap has ever written the manifest without
  // it. So "manifest but no digest" means the load tore between the two, and treating it as
  // unverifiable-but-acceptable would let exactly the first interrupted load through unchecked.
  if (recordedDigest !== actualDigest) {
    const detail =
      recordedDigest === ''
        ? `carries no ${STAGE_CONFIG_DIGEST_KEY}, which bootstrap writes in the same load as the manifest`
        : `does not match its ${STAGE_CONFIG_DIGEST_KEY}`
    console.error(
      `sst-with-cloudflare: the ${stage} stage configuration ${detail}, so a \`secret load\` was ` +
        'interrupted and the values are not all from one generation; rerun ' +
        `\`npm run bootstrap -- --stage ${stage}\``,
    )
    process.exit(1)
  }
  // A manifest that names a key the store does not hold describes a half-written store — a
  // `secret load` that failed part way, or a value removed by hand. Applying the rest would deploy a
  // configuration nobody assembled.
  if (missing.length > 0) {
    console.error(
      `sst-with-cloudflare: the ${stage} stage configuration is incomplete — ${STAGE_CONFIG_MANIFEST_KEY} ` +
        `names ${missing.join(', ')} but the store holds no value for them; rerun ` +
        `\`npm run bootstrap -- --stage ${stage}\``,
    )
    process.exit(1)
  }

  // A manifest can name only keys that are refused — bookkeeping, or entries the allowlist rejects —
  // and then nothing is applied while the store still reads as populated. Same outcome as an empty
  // store, same answer.
  if (Object.keys(apply).length === 0 && alreadySet.length === 0) {
    console.error(
      `sst-with-cloudflare: the ${stage} stage configuration applied nothing — ${STAGE_CONFIG_MANIFEST_KEY} ` +
        `names ${manifestNames(stored)} and none is storable configuration; rerun ` +
        `\`npm run bootstrap -- --stage ${stage}\``,
    )
    process.exit(1)
  }
  Object.assign(process.env, apply)

  const applied = Object.keys(apply)
  reportProgress(`sst-with-cloudflare: ${stage} stage configuration ... ${applied.length} keys loaded from the SST secret store`)
  if (alreadySet.length > 0) {
    reportProgress(`sst-with-cloudflare: ${stage} stage configuration ... already in the environment, left alone: ${alreadySet.join(', ')}`)
  }
  // Names only — a stored value is never printed. Worth surfacing rather than dropping silently: an
  // unlisted key is either a stale entry from a key since removed from .env, or one written by hand
  // that will never take effect.
  if (unlisted.length > 0) {
    console.warn(
      `sst-with-cloudflare: ${stage} stage configuration ... in the store but not applied ` +
        `(not named by ${STAGE_CONFIG_MANIFEST_KEY}, or not permitted): ${unlisted.join(', ')}`,
    )
  }
}

let stage
try {
  stage = resolveSstStage(sstArgs)
} catch (error: any) {
  console.error(`sst-with-cloudflare: ${error.message}`)
  process.exit(1)
}

// Before the store is read, not after: reading it initializes the Cloudflare provider, which needs
// these. A credential already in the environment is used as-is, which is the path CI takes — every
// step that reaches here is given the pair as Environment secrets, so the SSM lookup below never runs
// there. That is deliberate rather than incidental: whether this role can decrypt the parameter is
// untested (see the note at the top of this file), and nothing in CI should be the first to find out.
for (const { env, param } of CLOUDFLARE_CREDS) {
  if (process.env[env]) continue // already provided — don't touch
  const name = `/boxlite/${stage}/${param}`
  const value = fetchFromSsm(name)
  if (value) {
    process.env[env] = value
  } else {
    console.warn(
      `sst-with-cloudflare: ${env} not in env and ${name} not in SSM (${REGION}); ` +
        `seed it with \`npm run bootstrap -- --stage ${stage}\``,
    )
  }
}
if (terminationSignal) process.exit(signalExitCode(terminationSignal))

loadStageConfig(stage)

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

    const settle = (exitCode: any) => {
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
      reportProgress(
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
      reportProgress(
        `sst-with-cloudflare: Runner ${runnerSource.kind} artifact verified (${runnerArtifact.tarballUrl}, linux-amd64)`,
      )
    }
    if (deployScope.excluded.length > 0) {
      reportProgress(
        `sst-with-cloudflare: ${deployScope.excluded.join(', ')} excluded from this deploy; artifact unverified`,
      )
    }
  } catch (error: any) {
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
  } catch (error: any) {
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
} catch (error: any) {
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
        onRetry({ error, nextAttempt, attempts, delayMs }: any) {
          console.warn(
            `sst-with-cloudflare: Proxy routing is not ready (${error.message}); ` +
              `retrying ${nextAttempt}/${attempts} in ${delayMs / 1_000}s`,
          )
        },
      },
    )
    reportProgress(
      `sst-with-cloudflare: Proxy routing verified ` +
        `(${verification.healthyTargetCount}/${verification.desiredCount} healthy, ` +
        `listener → ${verification.targetGroupArn})`,
    )

    const publicVerification = await verifyPublicDeploymentWithRetry(publicDeploymentConfig, {
      signal: deploymentVerificationAbortController.signal,
      onRetry({ error, nextAttempt, attempts, delayMs }: any) {
        console.warn(
          `sst-with-cloudflare: public deployment is not ready (${error.message}); ` +
            `retrying ${nextAttempt}/${attempts} in ${delayMs / 1_000}s`,
        )
      },
    })
    reportProgress(
      `sst-with-cloudflare: public deployment verified ` +
        `(Proxy ${publicVerification.proxyHealthUrl}, wildcard ${publicVerification.proxyWildcardHealthUrl}, ` +
        `API ${publicVerification.apiConfigUrl}, ` +
        `version ${publicVerification.version}, issuer ${publicVerification.oidcIssuer})`,
    )
  } catch (error: any) {
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
