// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Idempotent, human-run environment preparation for a BoxLite SST
 * deployment: the GitHub OIDC deploy role + runtime IAM boundary
 * (ci/github-deploy-role.yaml), the Cloudflare provider credentials in SSM,
 * the OIDC_CLIENT_ID SST secret, stable runtime secrets, the immutable
 * deployment configuration release, and the GitHub `<stage>` Environment
 * variables the deploy workflow reads. See apps/infra/README.md's
 * "Deploy an existing stack" section for the full prerequisite list this
 * script does NOT cover (Cloudflare domain, Auth0/OIDC tenant, an existing
 * Runner — first-Runner provisioning is a separate, not-yet-built operation).
 *
 * Safe to re-run any number of times: every step reconciles to the desired
 * state instead of failing on "already exists". Requires AWS credentials
 * with IAM/SSM/CloudFormation access — deliberately NOT the scoped deploy
 * role this script provisions, which cannot touch CloudFormation or its own
 * IAM policy by design (see the CreateBoundedBoxLiteRoles /
 * SetBoxLiteRoleBoundary statements in ci/github-deploy-role.yaml) — and a
 * `gh` CLI authenticated against the target repo.
 *
 * Usage: node scripts/bootstrap-environment.mjs [--stage dev] [--repo owner/name]
 *                                               [--reviewers 123,456] [--env-file path] [--force]
 *   --stage      SST stage to bootstrap (default: dev, or SST_STAGE). The GitHub
 *                Environment must be named exactly this — the deploy role's trust
 *                policy pins `repo:<owner>/<repo>:environment:<stage>`.
 *   --repo       GitHub repo as owner/name (default: `gh repo view` in this checkout —
 *                a community fork resolves to itself automatically)
 *   --reviewers  Comma-separated numeric GitHub user ids required to approve a
 *                deployment (default: whoever is authenticated with `gh`)
 *   --env-file   Bootstrap input path (default: apps/infra/.env). Relative paths
 *                resolve from the caller's working directory, so an operator file
 *                outside a disposable worktree can be used without copying it.
 *   --force      Replace mutable provider/runtime secret values. Encryption
 *                key material and the default Runner API key cannot rotate in v1.
 *   --provision-auth0
 *                Create the Auth0 SPA app, custom API, and post-login Action
 *                (requires `npm run login` first). NOT idempotent — Auth0 has no
 *                upsert for apps or APIs, so rerunning creates duplicates.
 *
 * Sign-in: run `npm run login` first, which walks the browser sign-in for every
 * provider this needs (AWS via `aws login`, AWS CLI 2.32.0+ — no IAM user,
 * access keys, or IAM Identity Center setup required). An existing profile or
 * SSO session is used as-is if one is already active.
 *
 * Non-interactive use (e.g. wiring this into a more-privileged automation
 * later): set CLOUDFLARE_API_TOKEN, CLOUDFLARE_DEFAULT_ACCOUNT_ID, and
 * OIDC_CLIENT_ID in the environment and no prompts fire.
 *
 * Bootstrap publishes configuration and secret versions; it does not restart
 * ECS tasks or Runners. After a mutable-secret rotation, preview and apply the
 * newly current digest. First expand is bootstrap -> apply -> bootstrap again
 * to replace generated-pending markers -> preview/apply the finalized release.
 */

import { execFileSync } from 'node:child_process'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { devNull } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { hasFlag, parseFlag } from './cli-flags.mjs'
import {
  loadBootstrapEnvironment,
  resolveBootstrapEnvironmentPath,
  validateBootstrapArguments,
} from './bootstrap-environment-file.mjs'
import { validateBootstrapConsumerInvariants } from './bootstrap-consumer-validation.mjs'
import {
  canonicalizeDeploymentConfig,
  createDeploymentConfigDocument,
  PENDING_RUNTIME_SECRET_GENERATION,
  shieldSstEnvironment,
  validateRuntimeSecretGenerations,
  validateDeploymentConfigStage,
} from './deployment-config.mjs'
import { DeploymentConfigStore } from './deployment-config-store.mjs'
import { resolveAwsRegion } from './deployment-environment.mjs'
import {
  GITHUB_OIDC_PROVIDER_URL,
  MINIMUM_AWS_CLI_VERSION,
  cloudFormationDeployChanged,
  cloudFormationParameterOverrides,
  decideSsmOverwrite,
  githubDeployRoleStackName,
  hasGitHubOidcProvider,
  isAwsCliVersionAtLeast,
  ssmParameterName,
  sstPlatformState,
  validateGitHubRepo,
} from './environment-bootstrap.mjs'
import {
  bindActionArgs,
  createActionArgs,
  customApiArgs,
  deployActionArgs,
  enableRpLogoutDiscoveryArgs,
  spaApplicationArgs,
} from './auth0-provisioning.mjs'
import {
  environmentApiPath,
  githubEnvironmentPayload,
  isProtectionUnavailableError,
  parseReviewerIds,
} from './github-environment.mjs'
import { resolveAwsCliPath } from './proxy-deployment-verify.mjs'
import {
  evaluateRunnerCommandTagGate,
  parseRunnerEc2Instances,
} from './runner-command-tag-gate.mjs'
import runnerInventory from './runner-inventory.cjs'
import { readRunnerStateBaseline } from './runner-policy-baseline.mjs'
import {
  RUNTIME_SECRET_DEFINITIONS,
  RUNTIME_SECRET_INITIALIZATION_PENDING,
  RUNTIME_SECRET_INITIALIZATION_SEALED,
  RUNTIME_SECRET_INITIALIZATION_TAG,
  RUNTIME_SECRET_INITIAL_VALUE_TAG,
  SST_APP_SECRET_NAMES,
  resolveRuntimeSecretSeedValues,
  runtimeSecretName,
} from './runtime-secrets.mjs'
import { validateSstSecretMutationArgs } from './sst-command-contract.mjs'
import { withSstLogSecurity } from './sst-event-log-security.mjs'
import { resolveSstExecutable } from './sst-executable.mjs'
import { resolveSstStage } from './sst-stage.mjs'

const { resolveRunnerInventory } = runnerInventory

const SCRIPT_NAME = 'bootstrap-environment'
// The one stage that must never end up with an unreviewed deploy path. Matches
// PRODUCTION_STAGE in sst.config.ts, which gates retain-on-removal.
const PROTECTED_STAGE = 'prod'
const INFRA_ROOT = fileURLToPath(new URL('..', import.meta.url))
const TEMPLATE_PATH = join(INFRA_ROOT, 'ci', 'github-deploy-role.yaml')
const ENV_PATH = join(INFRA_ROOT, '.env')
const SST_WRAPPER_PATH = join(INFRA_ROOT, 'scripts', 'sst-with-cloudflare.mjs')
// Generous but bounded: a healthy platform install completed in ~85s here.
const SST_INSTALL_TIMEOUT_MS = 240_000
// The cold attempt gets a shorter leash than that, because a recovery sits
// behind it: giving up early costs at worst an npm install that would not have
// been needed, while waiting the full budget on an install that is not
// progressing costs four minutes of silence.
const SST_COLD_INSTALL_TIMEOUT_MS = 90_000
const ACTION_SOURCE_PATH = join(INFRA_ROOT, 'functions', 'auth0', 'setCustomClaims.onExecutePostLogin.js')

const CLOUDFLARE_CREDENTIALS = [
  {
    envVar: 'CLOUDFLARE_API_TOKEN',
    param: 'cloudflare-api-token',
    // Cloudflare issues the first API token through the dashboard only, so
    // this cannot be obtained by a browser login the way AWS/GitHub/Auth0 are.
    // Account-owned keeps the integration working after the creator leaves.
    label: 'Cloudflare API token (account-owned, Zone:Read + DNS:Edit)',
  },
  { envVar: 'CLOUDFLARE_DEFAULT_ACCOUNT_ID', param: 'cloudflare-account-id', label: 'Cloudflare account ID' },
]

function requireStageEnvFile(path) {
  if (!existsSync(path)) {
    throw new Error(`${path} does not exist; pass --env-file or run \`cp .env.example .env\` and fill it in first`)
  }
  return path
}

export function validateBootstrapStageSelection(stage, environment = process.env) {
  const ambientStage = environment.SST_STAGE
  if (ambientStage !== undefined && ambientStage !== '' && ambientStage !== stage) {
    throw new Error('ambient SST_STAGE conflicts with the selected bootstrap stage')
  }
  return stage
}

function requireGhAuthenticated() {
  try {
    // Capture stderr rather than discarding it: `gh auth status` validates the
    // token over the network, so it also exits non-zero when github.com is
    // unreachable. Only gh's own text separates that from a missing session,
    // and the advice below is right for just one of them.
    execFileSync('gh', ['auth', 'status'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
      timeout: 15_000,
      killSignal: 'SIGTERM',
    })
  } catch (cause) {
    const detail = cause.stderr?.trim()
    throw new Error(
      `GitHub CLI is not authenticated; run \`npm run login\` first${detail ? ` (gh said: ${detail})` : ''}`,
      { cause },
    )
  }
}

function resolveRepo(args) {
  const override = parseFlag(args, 'repo')
  if (override) return validateGitHubRepo(override)

  let nameWithOwner
  try {
    nameWithOwner = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      killSignal: 'SIGTERM',
    }).trim()
  } catch (cause) {
    throw new Error(
      "could not determine the GitHub repository from `gh repo view`; run this from the repo's working directory or pass --repo owner/name",
      { cause },
    )
  }
  return validateGitHubRepo(nameWithOwner)
}

/*
 * `aws login` (browser sign-in with AWS Management Console credentials) is the
 * lowest-friction way to get credentials here: it needs no IAM user, no
 * long-lived access keys, and no IAM Identity Center — which itself takes a
 * separate console setup. It landed in AWS CLI 2.32.0, so an older CLI can't
 * be pointed at it.
 */
function requireAwsCliWithLoginSupport(awsCliPath) {
  const versionBanner = execFileSync(awsCliPath, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
    killSignal: 'SIGTERM',
  })
  if (!isAwsCliVersionAtLeast(versionBanner)) {
    throw new Error(
      `AWS CLI ${MINIMUM_AWS_CLI_VERSION}+ is required for \`aws login\` (found ${versionBanner.trim().split(' ')[0]}); ` +
        'upgrade the CLI, or supply credentials another way before rerunning',
    )
  }
  return versionBanner
}

function currentAwsIdentity(awsCliPath, region) {
  let stdout
  try {
    stdout = execFileSync(awsCliPath, ['sts', 'get-caller-identity', '--region', region, '--output', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      killSignal: 'SIGTERM',
    })
  } catch (cause) {
    throw new Error(
      'no usable AWS credentials. Run `npm run login`, which opens the `aws login` browser sign-in ' +
        '(no IAM user or access keys needed; signing in as the account root works), then rerun this command. ' +
        'An existing profile or SSO session works too — this step only needs `sts:GetCallerIdentity` to succeed.',
      { cause },
    )
  }
  const identity = JSON.parse(stdout)
  if (!identity.Account || !identity.Arn) {
    throw new Error('aws sts get-caller-identity returned an unexpected response')
  }
  return identity
}

// A blank answer at the prompt, or an env var set to '', would otherwise be
// stored as a real secret and only surface as an auth failure at deploy time.
function requireNonEmptySecret(label, value) {
  const trimmed = value?.trim()
  if (!trimmed) throw new Error(`${label} cannot be empty`)
  return trimmed
}

// No native masked-input in node:readline — a minimal raw-mode reader avoids
// pulling in a prompt dependency for two secrets. TTY-gated: a non-interactive
// caller (CI, a script) must supply the value through the matching env var
// instead of hanging on a prompt that can never be answered.
function promptSecret(label) {
  if (!process.stdin.isTTY) {
    throw new Error(`${label} has no value and stdin is not a TTY to prompt for one; set the matching env var instead`)
  }
  process.stdout.write(label)
  return new Promise((resolvePrompt, reject) => {
    const { stdin } = process
    stdin.resume()
    stdin.setRawMode(true)
    stdin.setEncoding('utf8')
    let value = ''
    const cleanup = () => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
    }
    // Raw mode delivers a chunk, not a keystroke: a pasted token arrives as one
    // string, usually with its terminator attached. Comparing the chunk itself
    // sends the whole paste to `default`, so the secret keeps the trailing
    // control character and the prompt never resolves. Step through characters,
    // and stop at the first terminator so anything typed after it is ignored.
    let settled = false
    const onData = (chunk) => {
      for (const char of chunk) {
        if (settled) return
        switch (char) {
          case '\n':
          case '\r':
          case '\u0004':
            settled = true
            cleanup()
            process.stdout.write('\n')
            resolvePrompt(value)
            break
          case '\u0003':
            settled = true
            cleanup()
            process.stdout.write('\n')
            reject(new Error('interrupted'))
            break
          case '\u007f':
          case '\b':
            value = value.slice(0, -1)
            break
          default:
            value += char
        }
      }
    }
    stdin.on('data', onData)
  })
}

export function readSsmSecureParameter(
  awsCliPath,
  region,
  name,
  { execute = execFileSync } = {},
) {
  try {
    const value = execute(
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
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15_000,
        killSignal: 'SIGTERM',
        maxBuffer: 64 * 1024,
      },
    ).trim()
    if (!value || value === 'None') throw new Error('parameter returned no value')
    return { exists: true, value }
  } catch (error) {
    const detail = `${error?.code ?? ''}\n${error?.stderr ?? ''}\n${error?.message ?? ''}`
    if (/ParameterNotFound/i.test(detail)) return { exists: false }
    // AWS stderr and parsing errors are untrusted and may include provider
    // material. The public error identifies only the parameter name.
    throw new Error(`could not load SecureString parameter ${name}`)
  }
}

export function putSsmSecureParameter(
  awsCliPath,
  region,
  name,
  value,
  { execute = execFileSync, overwrite = false } = {},
) {
  if (typeof overwrite !== 'boolean') {
    throw new Error('SecureString overwrite selection must be boolean')
  }
  const args = [
    'ssm',
    'put-parameter',
    '--region',
    region,
    '--type',
    'SecureString',
    '--name',
    name,
    '--value',
    'file:///dev/stdin',
  ]
  if (overwrite) args.push('--overwrite')
  try {
    execute(
      awsCliPath,
      args,
      { input: value, encoding: 'utf8', stdio: ['pipe', 'ignore', 'pipe'], timeout: 15_000, killSignal: 'SIGTERM' },
    )
  } catch {
    throw new Error(`could not update SecureString parameter ${name}`)
  }
}

function inspectRuntimeSecret(execute, awsCliPath, region, name) {
  try {
    const metadata = JSON.parse(
      execute(awsCliPath, ['secretsmanager', 'describe-secret', '--region', region, '--secret-id', name], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15_000,
        killSignal: 'SIGTERM',
      }),
    )
    const currentVersionIds = Object.entries(metadata.VersionIdsToStages ?? {})
      .filter(([, stages]) => Array.isArray(stages) && stages.includes('AWSCURRENT'))
      .map(([versionId]) => versionId)
    if (currentVersionIds.length > 1) {
      throw new Error('runtime secret metadata contains multiple AWSCURRENT versions')
    }
    const currentVersionId = currentVersionIds[0]
    const hasCurrentValue = currentVersionId !== undefined
    if (!Array.isArray(metadata.Tags)) throw new Error('runtime secret metadata contains invalid tags')
    const readExactTag = (key) => {
      const matches = metadata.Tags.filter((tag) => tag?.Key === key)
      if (matches.length > 1 || (matches[0] && typeof matches[0].Value !== 'string')) {
        throw new Error('runtime secret metadata contains ambiguous ownership tags')
      }
      return matches[0]?.Value
    }
    const initialValue = readExactTag(RUNTIME_SECRET_INITIAL_VALUE_TAG)
    const initialization = readExactTag(RUNTIME_SECRET_INITIALIZATION_TAG)
    return { state: 'existing', initialValue, initialization, hasCurrentValue, currentVersionId }
  } catch (error) {
    const detail = `${error.stderr ?? ''}\n${error.message ?? ''}`
    if (/ResourceNotFoundException/i.test(detail)) {
      return {
        state: 'missing',
        initialValue: undefined,
        initialization: undefined,
        hasCurrentValue: false,
        currentVersionId: undefined,
      }
    }
    throw new Error(`could not inspect runtime secret container ${name}`, { cause: error })
  }
}

function runtimeSecretOwnershipTags(initialValue, initialization) {
  return JSON.stringify([
    { Key: RUNTIME_SECRET_INITIAL_VALUE_TAG, Value: initialValue },
    { Key: RUNTIME_SECRET_INITIALIZATION_TAG, Value: initialization },
  ])
}

function createRuntimeSecret(execute, awsCliPath, region, name, initialValue, initialization) {
  try {
    execute(
      awsCliPath,
      [
        'secretsmanager',
        'create-secret',
        '--region',
        region,
        '--name',
        name,
        '--description',
        'Stable BoxLite runtime secret managed by bootstrap',
        '--tags',
        runtimeSecretOwnershipTags(initialValue, initialization),
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], timeout: 30_000, killSignal: 'SIGTERM' },
    )
  } catch (error) {
    throw new Error(`could not create runtime secret container ${name}; its state may have changed after planning`, {
      cause: error,
    })
  }
}

function tagRuntimeSecret(execute, awsCliPath, region, name, initialValue, initialization) {
  execute(
    awsCliPath,
    [
      'secretsmanager',
      'tag-resource',
      '--region',
      region,
      '--secret-id',
      name,
      '--tags',
      runtimeSecretOwnershipTags(initialValue, initialization),
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], timeout: 15_000, killSignal: 'SIGTERM' },
  )
}

function seedRuntimeSecret(execute, awsCliPath, region, name, value, versionId) {
  try {
    execute(
      awsCliPath,
      [
        'secretsmanager',
        'put-secret-value',
        '--region',
        region,
        '--secret-id',
        name,
        '--secret-string',
        'file:///dev/stdin',
        '--client-request-token',
        versionId,
      ],
      {
        input: value,
        encoding: 'utf8',
        stdio: ['pipe', 'ignore', 'pipe'],
        timeout: 30_000,
        killSignal: 'SIGTERM',
      },
    )
  } catch {
    throw new Error(`could not seed runtime secret ${name}`)
  }
}

function readRuntimeSecretValue(execute, awsCliPath, region, name) {
  try {
    const source = execute(
      awsCliPath,
      [
        'secretsmanager',
        'get-secret-value',
        '--region',
        region,
        '--secret-id',
        name,
        '--query',
        'SecretString',
        '--output',
        'json',
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
        killSignal: 'SIGTERM',
      },
    )
    const value = JSON.parse(source)
    if (typeof value !== 'string') throw new Error('SecretString is unavailable')
    return value
  } catch {
    // AWS stdout may contain the current credential, including malformed JSON.
    // Do not retain it, the parser error, or the CLI failure as a printable cause.
    throw new Error(`could not compare the existing value for runtime secret ${name}`)
  }
}

function secretValuesEqual(left, right) {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

export function planRuntimeSecrets({
  awsCliPath,
  region,
  stage,
  seeds,
  force,
  execute = execFileSync,
  createVersionId = randomUUID,
}) {
  if (!Array.isArray(seeds)) throw new Error('validated runtime secret seeds are required')
  const definitions = new Map(RUNTIME_SECRET_DEFINITIONS.map((definition) => [definition.id, definition]))
  const seedById = new Map()
  for (const seed of seeds) {
    if (!definitions.has(seed?.id)) throw new Error(`unknown runtime secret seed id '${seed?.id ?? ''}'`)
    if (seedById.has(seed.id)) throw new Error(`duplicate runtime secret seed id '${seed.id}'`)
    if (typeof seed.value !== 'string' || !seed.value) throw new Error(`runtime secret seed ${seed.id} has no value`)
    seedById.set(seed.id, seed)
  }

  // Complete discovery first. No create/tag/put call is permitted until every
  // container's tags and AWSCURRENT state have been observed.
  const observations = RUNTIME_SECRET_DEFINITIONS.map((definition) => {
    const name = runtimeSecretName(stage, definition.id)
    return {
      definition,
      name,
      ownership: inspectRuntimeSecret(execute, awsCliPath, region, name),
      seed: seedById.get(definition.id),
    }
  })

  const plan = observations.map(({ definition, name, ownership, seed }) => {
    if (ownership.state === 'missing') {
      return {
        id: definition.id,
        name,
        seed,
        action: seed ? 'create-explicit' : 'create-generated',
        generation: seed ? createVersionId() : PENDING_RUNTIME_SECRET_GENERATION,
        message: seed ? 'seeded from local input' : 'created for generated initial value',
      }
    }

    const initialValue = ownership.initialValue
    if (!['generated', 'explicit', 'updating'].includes(initialValue)) {
      throw new Error(`runtime secret ${name} has invalid bootstrap ownership metadata`)
    }
    if (
      ownership.initialization !== undefined &&
      ![RUNTIME_SECRET_INITIALIZATION_PENDING, RUNTIME_SECRET_INITIALIZATION_SEALED].includes(
        ownership.initialization,
      )
    ) {
      throw new Error(`runtime secret ${name} has invalid bootstrap initialization metadata`)
    }
    if (initialValue === 'explicit' && ownership.initialization === RUNTIME_SECRET_INITIALIZATION_PENDING) {
      throw new Error(`runtime secret ${name} has an invalid explicit pending initialization state`)
    }
    if (
      initialValue === 'generated' &&
      ownership.initialization === RUNTIME_SECRET_INITIALIZATION_SEALED &&
      !ownership.hasCurrentValue
    ) {
      throw new Error(`runtime secret ${name} is sealed but has no AWSCURRENT value`)
    }

    if (!seed) {
      if (initialValue === 'updating') {
        throw new Error(
          `runtime secret ${name} has an incomplete explicit rotation; rerun bootstrap with its local seed value`,
        )
      }
      if (initialValue === 'explicit' && !ownership.hasCurrentValue) {
        throw new Error(
          `runtime secret ${name} is tagged explicit but has no AWSCURRENT value; supply its local seed to repair it`,
        )
      }
      let action
      if (initialValue === 'generated' && ownership.hasCurrentValue) {
        action =
          ownership.initialization === RUNTIME_SECRET_INITIALIZATION_SEALED
            ? 'retain-generated'
            : 'seal-generated'
      } else if (initialValue === 'generated') {
        action =
          ownership.initialization === RUNTIME_SECRET_INITIALIZATION_PENDING
            ? 'retain-generated'
            : 'tag-generated-pending'
      } else {
        action =
          ownership.initialization === RUNTIME_SECRET_INITIALIZATION_SEALED
            ? 'retain-explicit'
            : 'seal-explicit'
      }
      return {
        id: definition.id,
        name,
        action,
        generation: ownership.currentVersionId ?? PENDING_RUNTIME_SECRET_GENERATION,
        message: `${initialValue} value retained`,
      }
    }

    if (!ownership.hasCurrentValue) {
      return {
        id: definition.id,
        name,
        seed,
        action: 'seed-explicit',
        generation: createVersionId(),
        message: 'seeded from local input',
      }
    }

    const currentValue = readRuntimeSecretValue(execute, awsCliPath, region, name)
    if (secretValuesEqual(currentValue, seed.value)) {
      return {
        id: definition.id,
        name,
        action:
          initialValue === 'explicit' &&
          ownership.initialization === RUNTIME_SECRET_INITIALIZATION_SEALED
            ? 'retain-explicit'
            : 'seal-explicit',
        generation: ownership.currentVersionId,
        message: 'explicit value unchanged',
      }
    }
    if (definition.rotationPolicy === 'non-rotatable-v1') {
      throw new Error(`runtime secret ${name} cannot be rotated in v1 because ${definition.rotationBlockReason}`)
    }
    if (!force) {
      throw new Error(`runtime secret ${name} differs from local input; rerun bootstrap with --force to rotate it`)
    }
    return {
      id: definition.id,
      name,
      seed,
      action: 'rotate-explicit',
      generation: createVersionId(),
      message: 'rotated from local input',
    }
  })
  runtimeSecretGenerationsFromPlan(plan)
  return plan
}

export function runtimeSecretGenerationsFromPlan(plan) {
  if (!Array.isArray(plan)) throw new Error('a precomputed runtime secret plan is required')
  const generations = {}
  for (const item of plan) {
    if (typeof item?.id !== 'string' || Object.hasOwn(generations, item.id)) {
      throw new Error('runtime secret plan contains a missing or duplicate secret id')
    }
    generations[item.id] = item.generation
  }
  return validateRuntimeSecretGenerations(generations)
}

export function runtimeSecretInitializationRequired(plan) {
  return plan.some(
    (item) =>
      item.generation === PENDING_RUNTIME_SECRET_GENERATION &&
      (item.action === 'create-generated' || item.action === 'retain-generated' || item.action === 'tag-generated-pending'),
  )
}

export function partitionRuntimeSecretPlanForInitializationGate(plan) {
  runtimeSecretGenerationsFromPlan(plan)
  const sealBeforeEnable = plan.filter((item) => item.action === 'seal-generated')
  const remaining = plan.filter((item) => item.action !== 'seal-generated')
  return { sealBeforeEnable, remaining }
}

function applyRuntimeSecretActions({
  awsCliPath,
  region,
  plan,
  execute = execFileSync,
  log = console.log,
}) {
  if (!Array.isArray(plan)) throw new Error('a precomputed runtime secret plan is required')
  for (const item of plan) {
    if (item.action === 'create-generated') {
      createRuntimeSecret(
        execute,
        awsCliPath,
        region,
        item.name,
        'generated',
        RUNTIME_SECRET_INITIALIZATION_PENDING,
      )
    } else if (item.action === 'create-explicit') {
      createRuntimeSecret(
        execute,
        awsCliPath,
        region,
        item.name,
        'explicit',
        RUNTIME_SECRET_INITIALIZATION_SEALED,
      )
      seedRuntimeSecret(execute, awsCliPath, region, item.name, item.seed.value, item.generation)
    } else if (item.action === 'seed-explicit' || item.action === 'rotate-explicit') {
      seedRuntimeSecret(execute, awsCliPath, region, item.name, item.seed.value, item.generation)
      tagRuntimeSecret(
        execute,
        awsCliPath,
        region,
        item.name,
        'explicit',
        RUNTIME_SECRET_INITIALIZATION_SEALED,
      )
    } else if (item.action === 'seal-explicit') {
      tagRuntimeSecret(execute, awsCliPath, region, item.name, 'explicit', RUNTIME_SECRET_INITIALIZATION_SEALED)
    } else if (item.action === 'seal-generated') {
      tagRuntimeSecret(execute, awsCliPath, region, item.name, 'generated', RUNTIME_SECRET_INITIALIZATION_SEALED)
    } else if (item.action === 'tag-generated-pending') {
      tagRuntimeSecret(execute, awsCliPath, region, item.name, 'generated', RUNTIME_SECRET_INITIALIZATION_PENDING)
    } else if (!item.action.startsWith('retain-')) {
      throw new Error(`unknown runtime secret bootstrap action '${item.action}'`)
    }
    log(`[${SCRIPT_NAME}] runtime secret ${item.name} ... ${item.message}`)
  }
  return plan
}

export function applyRuntimeSecretPlan(options) {
  runtimeSecretGenerationsFromPlan(options?.plan)
  return applyRuntimeSecretActions(options)
}

export function applyRuntimeSecretPlanSubset(options) {
  if (!Array.isArray(options?.plan)) throw new Error('a precomputed runtime secret plan subset is required')
  for (const item of options.plan) {
    if (!RUNTIME_SECRET_DEFINITIONS.some(({ id }) => id === item?.id)) {
      throw new Error('runtime secret plan subset contains an unknown secret id')
    }
  }
  return applyRuntimeSecretActions(options)
}

export function ensureRuntimeSecrets({
  awsCliPath,
  region,
  stage,
  seeds,
  force,
  execute = execFileSync,
  log = console.log,
}) {
  const plan = planRuntimeSecrets({ awsCliPath, region, stage, seeds, force, execute })
  return applyRuntimeSecretPlan({ awsCliPath, region, plan, execute, log })
}

function validateCloudflareCredentialPlan(plan) {
  if (!Array.isArray(plan) || plan.length !== CLOUDFLARE_CREDENTIALS.length) {
    throw new Error('a complete Cloudflare credential plan is required')
  }
  for (const [index, definition] of CLOUDFLARE_CREDENTIALS.entries()) {
    const item = plan[index]
    if (
      item?.envVar !== definition.envVar ||
      item?.param !== definition.param ||
      typeof item.name !== 'string' ||
      !item.name.endsWith(`/${definition.param}`) ||
      typeof item.value !== 'string' ||
      !item.value ||
      !['retain', 'put'].includes(item.action) ||
      typeof item.overwrite !== 'boolean'
    ) {
      throw new Error('Cloudflare credential plan is invalid')
    }
  }
  return plan
}

export async function planCloudflareCredentials({
  awsCliPath,
  region,
  stage,
  force,
  environment = process.env,
  readParameter = readSsmSecureParameter,
  prompt = promptSecret,
}) {
  const plan = []
  for (const { envVar, param, label } of CLOUDFLARE_CREDENTIALS) {
    const name = ssmParameterName(stage, param)
    const fromEnv = environment[envVar]?.trim()
    const current = readParameter(awsCliPath, region, name)
    if (!current || typeof current.exists !== 'boolean') {
      throw new Error(`could not inspect SecureString parameter ${name}`)
    }
    if (current.exists && decideSsmOverwrite({ exists: true, force }) === 'skip') {
      plan.push({
        envVar,
        param,
        label,
        name,
        value: requireNonEmptySecret(label, current.value),
        action: 'retain',
        overwrite: false,
      })
      continue
    }
    const value = fromEnv || requireNonEmptySecret(label, await prompt(`${label}: `))
    plan.push({
      envVar,
      param,
      label,
      name,
      value,
      action: 'put',
      overwrite: current.exists,
      source: fromEnv ? envVar : 'prompt',
    })
  }
  return validateCloudflareCredentialPlan(plan)
}

export function injectCloudflareCredentialPlan(environment, plan) {
  if (!environment || typeof environment !== 'object') {
    throw new Error('Cloudflare credential injection requires an environment object')
  }
  const [apiToken, accountId] = validateCloudflareCredentialPlan(plan)
  environment.CLOUDFLARE_API_TOKEN = apiToken.value
  environment.CLOUDFLARE_DEFAULT_ACCOUNT_ID = accountId.value
  return environment
}

export function applyCloudflareCredentialPlan({
  awsCliPath,
  region,
  plan,
  putParameter = putSsmSecureParameter,
  log = console.log,
}) {
  for (const item of validateCloudflareCredentialPlan(plan)) {
    if (item.action === 'retain') {
      log(`[${SCRIPT_NAME}] ${item.label} ... already set (use --force to change)`)
      continue
    }
    putParameter(awsCliPath, region, item.name, item.value, { overwrite: item.overwrite })
    log(`[${SCRIPT_NAME}] ${item.label} ... ${item.source === item.envVar ? `set from ${item.envVar}` : 'set'}`)
  }
  return plan
}

export async function ensureCloudflareCredentials(options) {
  const plan = await planCloudflareCredentials(options)
  return applyCloudflareCredentialPlan({ ...options, plan })
}

const SST_PLATFORM_DIR = join(INFRA_ROOT, '.sst', 'platform')

/*
 * Install SST's platform (pulumi, bun, ~560 provider packages) before anything
 * that is timed tightly.
 *
 * On a clean checkout the first sst call of any kind pays this cost, and until
 * this step existed that call was `secret set` a few lines below — a one-second
 * operation whose timeout was sized accordingly, so the install was killed
 * mid-flight and surfaced as a bare ETIMEDOUT with SST's real error buried in
 * .sst/log/sst.log.
 *
 * The npm fallback below covers an install that starts and does not finish,
 * leaving package.json written but node_modules empty — a state observed on
 * this machine, where an `sst install` was still running after ten minutes
 * while npm populated the same tree in 42s. The cause was never isolated: a
 * later cold run completed through sst's own bun in 85s under the same proxy,
 * so do not read this as "bun is broken". It is recovery from a stuck install,
 * whatever stuck it. sst still has to run once first regardless, since it is
 * what writes .sst/platform/package.json.
 */
function ensureSstPlatform(stage) {
  if (sstPlatformState(SST_PLATFORM_DIR) === 'ready') {
    runBootstrapSst(['install', '--stage', stage], {
      timeout: SST_INSTALL_TIMEOUT_MS,
      label: 'install the SST platform',
    })
    console.log(`[${SCRIPT_NAME}] SST platform ... ready`)
    return
  }

  console.log(`[${SCRIPT_NAME}] SST platform ... installing (first run: pulumi + providers, a minute or two)`)
  try {
    runBootstrapSst(['install', '--stage', stage], {
      timeout: SST_COLD_INSTALL_TIMEOUT_MS,
      label: 'install the SST platform',
    })
  } catch (error) {
    if (sstPlatformState(SST_PLATFORM_DIR) !== 'deps-missing') throw error
    console.warn(
      `[${SCRIPT_NAME}] SST platform ... sst's installer did not finish and left no deps; ` +
        'retrying those with npm',
    )
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: SST_PLATFORM_DIR,
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: SST_INSTALL_TIMEOUT_MS,
      killSignal: 'SIGTERM',
    })
    runBootstrapSst(['install', '--stage', stage], {
      timeout: SST_INSTALL_TIMEOUT_MS,
      label: 'install the SST platform',
    })
  }
  console.log(`[${SCRIPT_NAME}] SST platform ... ready`)
}

/*
 * Every sst call goes through the wrapper `npm run deploy`/`diff` use (not a
 * bare sst binary) so this stays the one place that knows how to reach it —
 * see scripts/sst-with-cloudflare.mjs's own header comment for why.
 *
 * Nonsecret operations retain SST's diagnostic tail. Secret mutations use the
 * dedicated path below because SST's raw log is not a safe output channel for
 * credential-bearing commands.
 */
function executeBootstrapSst(
  args,
  {
    input,
    timeout,
    execute,
    infraRoot,
    wrapperPath,
  },
) {
  return execute(process.execPath, [wrapperPath, ...args], {
    ...(input === undefined ? {} : { input }),
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'],
    timeout,
    killSignal: 'SIGTERM',
    cwd: infraRoot,
  })
}

function sstFailureHint(cause, timeout) {
  return cause.code === 'ETIMEDOUT' ? ` after ${Math.round(timeout / 1000)}s` : ''
}

function removeBootstrapSstDiagnosticLog(infraRoot, phase) {
  const logPath = join(infraRoot, '.sst', 'log', 'sst.log')
  try {
    unlinkSync(logPath)
  } catch (cause) {
    if (cause.code === 'ENOENT') return
    throw new Error(`could not remove the SST diagnostic log ${phase} a secret mutation`, { cause })
  }
}

export function runBootstrapSst(
  args,
  {
    timeout,
    label,
    execute = execFileSync,
    infraRoot = INFRA_ROOT,
    wrapperPath = SST_WRAPPER_PATH,
  },
) {
  if (!Array.isArray(args) || args.length !== 3 || args[0] !== 'install' || args[1] !== '--stage') {
    throw new Error('the nonsecret bootstrap SST runner accepts only install with one explicit --stage')
  }
  validateDeploymentConfigStage(args[2])
  try {
    return executeBootstrapSst(args, { timeout, execute, infraRoot, wrapperPath })
  } catch (cause) {
    throw new Error(`could not ${label}${sstFailureHint(cause, timeout)}${sstLogTail(5, infraRoot)}`, { cause })
  }
}

export function runBootstrapSstSecretMutation(
  args,
  {
    input,
    timeout,
    label,
    execute = execFileSync,
    infraRoot = INFRA_ROOT,
    wrapperPath = SST_WRAPPER_PATH,
  },
) {
  const { operation, name, confirmation, sstArgs } = validateSstSecretMutationArgs(args)
  if (!SST_APP_SECRET_NAMES.includes(name)) {
    throw new Error('the bootstrap SST secret name is not registered')
  }
  if (confirmation !== undefined) {
    throw new Error('bootstrap SST secret mutations do not accept a confirmation option')
  }
  if (operation === 'set' && (typeof input !== 'string' || !input)) {
    throw new Error(`${label} requires a non-empty secret value`)
  }
  if (operation === 'remove' && input !== undefined) {
    throw new Error(`${label} must not receive a secret value`)
  }
  removeBootstrapSstDiagnosticLog(infraRoot, 'before')
  try {
    return executeBootstrapSst(sstArgs, { input, timeout, execute, infraRoot, wrapperPath })
  } catch (cause) {
    // Never attach .sst/log/sst.log here. It is an unstructured third-party
    // diagnostic and may contain the stdin value supplied to `sst secret`.
    throw new Error(`could not ${label}${sstFailureHint(cause, timeout)}`, { cause })
  } finally {
    removeBootstrapSstDiagnosticLog(infraRoot, 'after')
  }
}

function sstLogTail(lines = 5, infraRoot = INFRA_ROOT) {
  try {
    const tail = readFileSync(join(infraRoot, '.sst', 'log', 'sst.log'), 'utf8').trimEnd().split('\n').slice(-lines)
    return tail.length ? `\n  last lines of .sst/log/sst.log:\n${tail.map((line) => `    ${line}`).join('\n')}` : ''
  } catch {
    return '' // no log yet — the wrapper's own stderr is all there is
  }
}

async function ensureOidcClientId(stage) {
  // `?.trim() || undefined` rather than `??`: an env var set to the empty
  // string is a misconfiguration, not a choice to store nothing, and `??` would
  // accept it and seed an empty secret that only fails at deploy time.
  const fromEnv = process.env.OIDC_CLIENT_ID?.trim() || undefined
  const value = requireNonEmptySecret('OIDC client ID', fromEnv ?? (await promptSecret('OIDC client ID: ')))
  // 120s, not 60s: the platform is warm by now, but this still writes to the
  // stage's secret store over the network and a slow link should not look like
  // a broken one.
  runBootstrapSstSecretMutation(['secret', 'set', 'OIDC_CLIENT_ID', '--stage', stage], {
    input: value,
    timeout: 120_000,
    label: 'set the OIDC_CLIENT_ID secret',
  })
  console.log(`[${SCRIPT_NAME}] OIDC_CLIENT_ID ... set${fromEnv ? ' from OIDC_CLIENT_ID env' : ''}`)
}

function ensureConfiguredSstSecrets(stage, configuredKeys) {
  const configured = new Set(configuredKeys)
  for (const name of SST_APP_SECRET_NAMES) {
    if (name === 'OIDC_CLIENT_ID') continue
    if (!configured.has(name)) continue
    runBootstrapSstSecretMutation(['secret', 'set', name, '--stage', stage], {
      input: process.env[name],
      timeout: 120_000,
      label: `set the ${name} secret`,
    })
    console.log(`[${SCRIPT_NAME}] ${name} ... set from local input`)
  }
}

/*
 * The deploy role's trust policy federates to this provider, but the provider
 * is account-global and CreateOpenIDConnectProvider rejects a duplicate URL
 * with EntityAlreadyExists — so detect before creating. Any account that has
 * ever wired GitHub Actions to AWS already has one. The thumbprint is
 * deliberately omitted: since July 2023 IAM validates GitHub's OIDC endpoint
 * against trusted root CAs, so pinning one would only create rotation work.
 */
function ensureGitHubOidcProvider({ awsCliPath, region }) {
  const listOutput = JSON.parse(
    execFileSync(awsCliPath, ['iam', 'list-open-id-connect-providers', '--region', region, '--output', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      killSignal: 'SIGTERM',
    }),
  )
  if (hasGitHubOidcProvider(listOutput)) {
    console.log(`[${SCRIPT_NAME}] GitHub OIDC provider ... already registered`)
    return
  }

  execFileSync(
    awsCliPath,
    [
      'iam',
      'create-open-id-connect-provider',
      '--region',
      region,
      '--url',
      GITHUB_OIDC_PROVIDER_URL,
      '--client-id-list',
      'sts.amazonaws.com',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], timeout: 30_000, killSignal: 'SIGTERM' },
  )
  console.log(`[${SCRIPT_NAME}] GitHub OIDC provider ... created`)
}

function authenticatedGitHubUserId() {
  return Number(
    execFileSync('gh', ['api', 'user', '--jq', '.id'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      killSignal: 'SIGTERM',
    }).trim(),
  )
}

/*
 * The deploy workflow binds to `environment: <stage>` and the role's trust
 * policy pins `repo:<owner>/<repo>:environment:<stage>`, so this must exist
 * under exactly the stage name before either works. `gh variable set --env`
 * does NOT create it.
 */
function ensureGithubEnvironment({ repo, stage, reviewerIds }) {
  const payload = githubEnvironmentPayload({ reviewerIds })
  try {
    execFileSync('gh', ['api', '--method', 'PUT', environmentApiPath(repo, stage), '--input', '-'], {
      input: JSON.stringify(payload),
      stdio: ['pipe', 'ignore', 'pipe'],
      timeout: 30_000,
      killSignal: 'SIGTERM',
    })
    const reviewers = reviewerIds.length > 0 ? `required reviewers: ${reviewerIds.join(', ')}` : 'no required reviewers'
    console.log(`[${SCRIPT_NAME}] GitHub ${stage} environment ... ready (${reviewers})`)
    return
  } catch (error) {
    const stderr = error.stderr?.toString() ?? ''
    if (!isProtectionUnavailableError(stderr) || reviewerIds.length === 0) throw error

    // Fail closed on the protected stage. Everywhere else an unprotected
    // environment is a downgrade worth taking to keep bootstrap moving; for
    // prod it would silently produce the thing the reviewers exist to prevent
    // — a stage anyone who can run the workflow can deploy unreviewed.
    if (stage === PROTECTED_STAGE) {
      throw new Error(
        `refusing to create the GitHub '${stage}' environment without required reviewers: ` +
          'deployment protection rules need a public repository, or GitHub Pro/Team/Enterprise ' +
          'on a private one. Enable protection for this repository, then rerun.',
        { cause: error },
      )
    }

    // Protection rules need a public repo, or a paid plan on a private one.
    // The environment itself still has to exist for vars/secrets to land, so
    // fall back to an unprotected one rather than blocking the bootstrap.
    execFileSync('gh', ['api', '--method', 'PUT', environmentApiPath(repo, stage), '--input', '-'], {
      input: JSON.stringify(githubEnvironmentPayload({ reviewerIds: [] })),
      stdio: ['pipe', 'ignore', 'inherit'],
      timeout: 30_000,
      killSignal: 'SIGTERM',
    })
    console.warn(
      `[${SCRIPT_NAME}] GitHub ${stage} environment ... created WITHOUT required reviewers ` +
        '(deployment protection rules need a public repository, or GitHub Pro/Team/Enterprise on a private one). ' +
        'Anyone who can run the workflow can deploy this stage unreviewed.',
    )
  }
}

function auth0Json(args) {
  return JSON.parse(
    execFileSync('auth0', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      killSignal: 'SIGTERM',
    }),
  )
}

function auth0Run(args) {
  execFileSync('auth0', args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000, killSignal: 'SIGTERM' })
}

/*
 * Collapses the five manual Auth0 dashboard steps in README's "OIDC provider
 * setup" into API calls. The `auth0 login` device-code token already carries
 * every scope this needs, so there is no create-an-M2M-app-first step.
 *
 * Not idempotent the way the AWS/GitHub steps are: Auth0 has no upsert for
 * applications or APIs, so rerunning creates duplicates. Gated behind an
 * explicit flag for that reason.
 */
function provisionAuth0({ stackDomain }) {
  try {
    execFileSync('auth0', ['tenants', 'list'], { stdio: 'ignore', timeout: 30_000, killSignal: 'SIGTERM' })
  } catch (cause) {
    throw new Error('the auth0 CLI is not authenticated; run `npm run login` and complete the browser consent', { cause })
  }

  const app = auth0Json(spaApplicationArgs({ stackDomain }))
  const clientId = app.client_id ?? app.clientId
  if (!clientId) throw new Error('auth0 apps create returned no client_id')
  console.log(`[${SCRIPT_NAME}] Auth0 SPA application ... created (client_id ${clientId})`)

  const api = auth0Json(customApiArgs({ stackDomain }))
  console.log(`[${SCRIPT_NAME}] Auth0 custom API ... created (audience ${api.identifier})`)

  const actionCode = readFileSync(ACTION_SOURCE_PATH, 'utf8')
  const action = auth0Json(createActionArgs({ code: actionCode }))
  const actionId = action.id
  if (!actionId) throw new Error('auth0 actions create returned no id')

  // deploy != bind: an Action must be deployed before it can be bound, and
  // the CLI has no bind verb, so the binding goes through the raw API.
  auth0Run(deployActionArgs(actionId))
  const existingBindings = auth0Json(['api', 'get', 'actions/triggers/post-login/bindings']).bindings ?? []
  auth0Run(bindActionArgs({ actionId, existingBindings }))
  console.log(`[${SCRIPT_NAME}] Auth0 post-login Action ... created, deployed, and bound`)

  auth0Run(enableRpLogoutDiscoveryArgs())
  console.log(`[${SCRIPT_NAME}] Auth0 RP-initiated logout discovery ... enabled`)

  // OIDC_CLIENT_ID is an SST secret, not a .env key — seeded below by
  // ensureOidcClientId. Only OIDC_AUDIENCE belongs in .env.
  console.log(`[${SCRIPT_NAME}] add to .env: OIDC_AUDIENCE=${api.identifier}`)
  console.log(`[${SCRIPT_NAME}] supply this when prompted for the OIDC client ID: ${clientId}`)
}

export function readCloudFormationBooleanParameter({
  awsCliPath,
  region,
  stackName,
  parameterName,
  execute = execFileSync,
}) {
  try {
    const value = execute(
      awsCliPath,
      [
        'cloudformation',
        'describe-stacks',
        '--region',
        region,
        '--stack-name',
        stackName,
        '--query',
        `Stacks[0].Parameters[?ParameterKey=='${parameterName}'].ParameterValue | [0]`,
        '--output',
        'text',
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
        killSignal: 'SIGTERM',
      },
    ).trim()
    if (value === '' || value === 'None') return false
    if (value === 'true') return true
    if (value === 'false') return false
    throw new Error('CloudFormation returned an invalid boolean parameter')
  } catch (error) {
    const detail = `${error?.stderr ?? ''}\n${error?.message ?? ''}`
    if (/ValidationError[\s\S]*Stack with id[\s\S]*does not exist/i.test(detail)) return false
    throw new Error(`could not inspect CloudFormation safety parameter ${parameterName}`)
  }
}

function describeEc2Instances(awsCliPath, region, execute = execFileSync) {
  try {
    return parseRunnerEc2Instances(
      execute(
        awsCliPath,
        ['ec2', 'describe-instances', '--region', region, '--output', 'json', '--no-cli-pager'],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 60_000,
          killSignal: 'SIGTERM',
          maxBuffer: 16 * 1024 * 1024,
        },
      ),
    )
  } catch {
    throw new Error('could not verify Runner command authorization tags from EC2 metadata')
  }
}

async function resolveRunnerCommandTagGate({ awsCliPath, region, stage, stackName, cloudflareCredentialPlan }) {
  const previousEnabled = readCloudFormationBooleanParameter({
    awsCliPath,
    region,
    stackName,
    parameterName: 'RunnerCommandTagGateEnabled',
  })
  const nativeEnvironment = { ...process.env }
  const sstPath = resolveSstExecutable(nativeEnvironment)
  shieldSstEnvironment(nativeEnvironment)
  injectCloudflareCredentialPlan(nativeEnvironment, cloudflareCredentialPlan)
  nativeEnvironment.SST_STAGE = stage
  nativeEnvironment.SST_LOG = devNull
  const serializedBaseline = await withSstLogSecurity(INFRA_ROOT, () =>
    readRunnerStateBaseline({
      stage,
      sstPath,
      sstArgs: ['state'],
      environment: nativeEnvironment,
      workingDirectory: INFRA_ROOT,
    }),
  )
  let baseline
  try {
    baseline = JSON.parse(serializedBaseline)
  } catch {
    throw new Error('could not verify Runner command authorization from the SST state baseline')
  }
  return evaluateRunnerCommandTagGate({
    previousEnabled,
    stage,
    desiredInventory: resolveRunnerInventory(process.env),
    baseline,
    instances: describeEc2Instances(awsCliPath, region),
  })
}

function deployGithubDeployRoleStack({ awsCliPath, region, stackName, overrides }) {
  const deployStdout = execFileSync(
    awsCliPath,
    [
      'cloudformation',
      'deploy',
      '--region',
      region,
      '--stack-name',
      stackName,
      '--template-file',
      TEMPLATE_PATH,
      '--capabilities',
      'CAPABILITY_NAMED_IAM',
      '--no-fail-on-empty-changeset',
      '--parameter-overrides',
      ...overrides,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 300_000, killSignal: 'SIGTERM' },
  )
  console.log(deployStdout.trim())
  console.log(
    `[${SCRIPT_NAME}] ${stackName} ... ${cloudFormationDeployChanged(deployStdout) ? 'created/updated' : 'already up to date'}`,
  )

  const roleArn = execFileSync(
    awsCliPath,
    [
      'cloudformation',
      'describe-stacks',
      '--region',
      region,
      '--stack-name',
      stackName,
      '--query',
      "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue",
      '--output',
      'text',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, killSignal: 'SIGTERM' },
  ).trim()
  if (!roleArn) throw new Error(`${stackName} produced no RoleArn output`)
  return roleArn
}

function ghVariableSet({ repo, stage, name, value }) {
  execFileSync('gh', ['variable', 'set', name, '--repo', repo, '--env', stage, '--body', value], {
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 30_000,
    killSignal: 'SIGTERM',
  })
}

function wireGithubEnvironment({ repo, stage, region, roleArn }) {
  ghVariableSet({ repo, stage, name: 'AWS_DEPLOY_ROLE_ARN', value: roleArn })
  ghVariableSet({ repo, stage, name: 'AWS_REGION', value: region })
  console.log(`[${SCRIPT_NAME}] GitHub ${stage} environment ... AWS_DEPLOY_ROLE_ARN, AWS_REGION set`)
}

export function commitBootstrapConfigRelease({
  deploymentConfigStore,
  publicationInput,
  runtimeSecretInitializationEnabled = false,
  sealRuntimeSecrets = () => {},
  deployBootstrapPolicy = () => {},
  applyRuntimeSecrets,
}) {
  if (!deploymentConfigStore || typeof deploymentConfigStore.prepare !== 'function') {
    throw new Error('bootstrap config commit requires a deployment config store with prepare()')
  }
  if (typeof deploymentConfigStore.activate !== 'function') {
    throw new Error('bootstrap config commit requires a deployment config store with activate()')
  }
  if (typeof applyRuntimeSecrets !== 'function') {
    throw new Error('bootstrap config commit requires a runtime secret apply callback')
  }
  if (typeof runtimeSecretInitializationEnabled !== 'boolean') {
    throw new Error('bootstrap config commit requires a boolean runtime secret initialization gate')
  }
  if (typeof sealRuntimeSecrets !== 'function' || typeof deployBootstrapPolicy !== 'function') {
    throw new Error('bootstrap config commit requires runtime secret sealing and policy callbacks')
  }

  // Retain a byte-verified immutable release before rotating any stable
  // secret. A failed apply can then be repaired by a normal bootstrap rerun;
  // current remains unchanged until the complete precomputed plan succeeds.
  const prepared = deploymentConfigStore.prepare(publicationInput)
  // When a later generated container needs initialization, close every old
  // pending+AWSCURRENT container before re-enabling PutSecretValue. On the
  // ordinary finalization path, first remove that Put grant and only then seal.
  if (runtimeSecretInitializationEnabled) sealRuntimeSecrets()
  deployBootstrapPolicy()
  if (!runtimeSecretInitializationEnabled) sealRuntimeSecrets()
  applyRuntimeSecrets()
  return deploymentConfigStore.activate({
    stage: publicationInput.stage,
    releaseId: prepared.releaseId,
  })
}

async function main() {
  const args = process.argv.slice(2)
  validateBootstrapArguments(args)
  const environmentPath = requireStageEnvFile(
    resolveBootstrapEnvironmentPath({ args, defaultPath: ENV_PATH }),
  )
  const { configuredKeys } = loadBootstrapEnvironment({ path: environmentPath, environment: process.env })
  const runtimeSecretSeeds = resolveRuntimeSecretSeedValues(process.env)
  validateBootstrapConsumerInvariants({ environment: process.env, configuredKeys, runtimeSecretSeeds })
  const stage = resolveSstStage(args)
  validateDeploymentConfigStage(stage)
  validateBootstrapStageSelection(stage)
  // This bootstrap-specific grammar is stricter than SST's general stage
  // grammar because the stage is also part of a CloudFormation stack name.
  // Prepare it before any external mutation so an underscore cannot leave a
  // half-provisioned GitHub/AWS environment.
  const deployRoleStackName = githubDeployRoleStackName(stage)
  const force = hasFlag(args, 'force')
  const region = resolveAwsRegion()
  const awsCliPath = resolveAwsCliPath()
  const reviewerIds = parseReviewerIds(parseFlag(args, 'reviewers'))

  requireGhAuthenticated()
  const repo = resolveRepo(args)
  requireAwsCliWithLoginSupport(awsCliPath)
  const identity = currentAwsIdentity(awsCliPath, region)

  // Secrets Manager VersionIds may be as long as 64 characters. Size and type
  // check that conservative release shape before the SSM lock write; otherwise
  // a valid plan could acquire the lock only to discover that it cannot fit in
  // a Standard Parameter.
  const worstCaseRuntimeSecretGenerations = Object.fromEntries(
    RUNTIME_SECRET_DEFINITIONS.map(({ id }) => [id, 'a'.repeat(64)]),
  )
  const deploymentConfigPreflightDocument = createDeploymentConfigDocument({
    environment: process.env,
    configuredKeys,
    stage,
    region,
    accountId: identity.Account,
    runtimeSecretGenerations: worstCaseRuntimeSecretGenerations,
  })
  canonicalizeDeploymentConfig(deploymentConfigPreflightDocument)

  console.log(`[${SCRIPT_NAME}] stage=${stage} region=${region} repo=${repo}`)
  console.log(`[${SCRIPT_NAME}] AWS identity ... ${identity.Arn}`)

  const deploymentConfigStore = new DeploymentConfigStore({ awsCliPath, region })
  await deploymentConfigStore.withDeploymentOperationLock({ stage }, async () => {
    // Planning observes every secret while this stage's operation lock is held,
    // so no cooperating bootstrap or stack evaluation can act on the old state.
    const runtimeSecretPlan = planRuntimeSecrets({
      awsCliPath,
      region,
      stage,
      seeds: runtimeSecretSeeds,
      force,
    })
    const runtimeSecretGenerations = runtimeSecretGenerationsFromPlan(runtimeSecretPlan)
    const runtimeSecretInitializationEnabled = runtimeSecretInitializationRequired(runtimeSecretPlan)
    const { sealBeforeEnable, remaining } = partitionRuntimeSecretPlanForInitializationGate(runtimeSecretPlan)
    // Validate the exact observed/preallocated generations before any provider
    // mutation. Publication itself stays last, after every referenced secret
    // container and the deploy role are ready.
    const deploymentConfigDocument = createDeploymentConfigDocument({
      environment: process.env,
      configuredKeys,
      stage,
      region,
      accountId: identity.Account,
      runtimeSecretGenerations,
    })
    canonicalizeDeploymentConfig(deploymentConfigDocument)
    const cloudflareCredentialPlan = await planCloudflareCredentials({
      awsCliPath,
      region,
      stage,
      force,
    })

    // Default the reviewer to whoever is running this, so the environment comes
    // out actually protected rather than nominally so.
    const effectiveReviewerIds = reviewerIds.length > 0 ? reviewerIds : [authenticatedGitHubUserId()]

    // Install locally before the first timed state read, then finish every
    // fallible live gate inspection before mutating GitHub, AWS, or providers.
    ensureSstPlatform(stage)
    const runnerCommandTagGateEnabled = await resolveRunnerCommandTagGate({
      awsCliPath,
      region,
      stage,
      stackName: deployRoleStackName,
      cloudflareCredentialPlan,
    })

    ensureGitHubOidcProvider({ awsCliPath, region })
    ensureGithubEnvironment({ repo, stage, reviewerIds: effectiveReviewerIds })
    if (hasFlag(args, 'provision-auth0')) {
      const stackDomain = process.env.STACK_DOMAIN
      if (!stackDomain) throw new Error('STACK_DOMAIN must be set in .env before --provision-auth0 can build callback URLs')
      provisionAuth0({ stackDomain })
    }
    applyCloudflareCredentialPlan({ awsCliPath, region, plan: cloudflareCredentialPlan })
    ensureConfiguredSstSecrets(stage, configuredKeys)
    await ensureOidcClientId(stage)
    const publication = commitBootstrapConfigRelease({
      deploymentConfigStore,
      publicationInput: {
        stage,
        environment: process.env,
        configuredKeys,
        runtimeSecretGenerations,
      },
      runtimeSecretInitializationEnabled,
      sealRuntimeSecrets() {
        applyRuntimeSecretPlanSubset({ awsCliPath, region, plan: sealBeforeEnable })
      },
      deployBootstrapPolicy() {
        const roleArn = deployGithubDeployRoleStack({
          awsCliPath,
          region,
          stackName: deployRoleStackName,
          overrides: cloudFormationParameterOverrides({
            repo,
            stage,
            runnerCommandTagGateEnabled,
            runtimeSecretInitializationEnabled,
          }),
        })
        // GitHub wiring is a prerequisite, not post-commit cleanup. A failure
        // here must leave the old /current pointer and runtime generations intact.
        wireGithubEnvironment({ repo, stage, region, roleArn })
      },
      applyRuntimeSecrets() {
        applyRuntimeSecretPlanSubset({ awsCliPath, region, plan: remaining })
      },
    })
    console.log(
      `[${SCRIPT_NAME}] deployment config ${publication.releaseId} ... ` +
        `${publication.isCurrent ? 'current' : 'published; another concurrent release is current'}`,
    )
  })

  console.log(
    `[${SCRIPT_NAME}] done. Preview next: gh workflow run deploy-infra.yml --repo ${repo} --ref main -f stage=${stage} -f apply=false`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main()
  } catch (error) {
    // Print the cause chain. Several checks here wrap a tool failure in advice
    // ("GitHub CLI is not authenticated; run `npm run login` first"), and the
    // advice is only right for one of the ways that tool can fail — `gh auth
    // status` also exits non-zero when it cannot reach github.com. Without the
    // cause an operator whose session is fine is sent to re-authenticate.
    console.error(`${SCRIPT_NAME}: ${error.message}`)
    for (let cause = error.cause; cause; cause = cause.cause) {
      console.error(`${SCRIPT_NAME}:   caused by: ${cause.message ?? cause}`)
    }
    process.exit(1)
  }
}
