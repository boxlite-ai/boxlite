// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Idempotent, human-run environment preparation for a BoxLite SST
 * deployment: the GitHub OIDC deploy role + runtime IAM boundary
 * (ci/github-deploy-role.yaml), the Cloudflare provider credentials in SSM,
 * the OIDC_CLIENT_ID SST secret, and the GitHub `<stage>` Environment
 * variables/secret the deploy workflow reads. See apps/infra/README.md's
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
 *                                               [--reviewers 123,456] [--force]
 *   --stage      SST stage to bootstrap (default: dev, or SST_STAGE). The GitHub
 *                Environment must be named exactly this — the deploy role's trust
 *                policy pins `repo:<owner>/<repo>:environment:<stage>`.
 *   --repo       GitHub repo as owner/name (default: `gh repo view` in this checkout —
 *                a community fork resolves to itself automatically)
 *   --reviewers  Comma-separated numeric GitHub user ids required to approve a
 *                deployment (default: whoever is authenticated with `gh`)
 *   --force      see decideSsmOverwrite() in environment-bootstrap.mjs
 *   --provision-auth0
 *                Create the Auth0 SPA app, custom API, and post-login Action
 *                (requires `auth0 login` first). NOT idempotent — Auth0 has no
 *                upsert for apps or APIs, so rerunning creates duplicates.
 *
 * AWS credentials: run `aws login` (browser sign-in, AWS CLI 2.32.0+) — no IAM
 * user, access keys, or IAM Identity Center setup required. An existing profile
 * or SSO session is used as-is if one is already active.
 *
 * Non-interactive use (e.g. wiring this into a more-privileged automation
 * later): set CLOUDFLARE_API_TOKEN, CLOUDFLARE_DEFAULT_ACCOUNT_ID, and
 * OIDC_CLIENT_ID in the environment and no prompts fire.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadDeploymentEnvironment, resolveAwsRegion } from './deployment-environment.mjs'
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
import { resolveSstStage } from './sst-stage.mjs'

const SCRIPT_NAME = 'bootstrap-environment'
const INFRA_ROOT = fileURLToPath(new URL('..', import.meta.url))
const TEMPLATE_PATH = join(INFRA_ROOT, 'ci', 'github-deploy-role.yaml')
const ENV_PATH = join(INFRA_ROOT, '.env')
const SST_WRAPPER_PATH = join(INFRA_ROOT, 'scripts', 'sst-with-cloudflare.mjs')
const ACTION_SOURCE_PATH = join(INFRA_ROOT, 'functions', 'auth0', 'setCustomClaims.onExecutePostLogin.js')

const CLOUDFLARE_CREDENTIALS = [
  { envVar: 'CLOUDFLARE_API_TOKEN', param: 'cloudflare-api-token', label: 'Cloudflare API token' },
  { envVar: 'CLOUDFLARE_DEFAULT_ACCOUNT_ID', param: 'cloudflare-account-id', label: 'Cloudflare account ID' },
]

function parseFlag(args, name) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === `--${name}`) {
      const value = args[index + 1]
      if (!value || value.startsWith('-')) throw new Error(`--${name} requires a value`)
      return value
    }
    const inline = args[index].match(new RegExp(`^--${name}=(.*)$`))?.[1]
    if (inline !== undefined) return inline
  }
  return undefined
}

function hasFlag(args, name) {
  return args.includes(`--${name}`)
}

function requireStageEnvFile() {
  if (!existsSync(ENV_PATH)) {
    throw new Error(`${ENV_PATH} does not exist; run \`cp .env.example .env\` and fill it in first`)
  }
  return ENV_PATH
}

function requireGhAuthenticated() {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore', timeout: 15_000, killSignal: 'SIGTERM' })
  } catch (cause) {
    throw new Error('GitHub CLI is not authenticated; run `gh auth login` first', { cause })
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
      'no usable AWS credentials. Run `aws login` and complete the browser sign-in ' +
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
    const onData = (char) => {
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004':
          cleanup()
          process.stdout.write('\n')
          resolvePrompt(value)
          break
        case '\u0003':
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
    stdin.on('data', onData)
  })
}

function ssmParameterExists(awsCliPath, region, name) {
  try {
    execFileSync(awsCliPath, ['ssm', 'get-parameter', '--region', region, '--name', name], {
      stdio: 'ignore',
      timeout: 15_000,
      killSignal: 'SIGTERM',
    })
    return true
  } catch {
    return false // ParameterNotFound (or a transient error — the put below is the real signal)
  }
}

function putSsmSecureParameter(awsCliPath, region, name, value) {
  execFileSync(
    awsCliPath,
    ['ssm', 'put-parameter', '--region', region, '--type', 'SecureString', '--name', name, '--value', 'file:///dev/stdin', '--overwrite'],
    { input: value, encoding: 'utf8', stdio: ['pipe', 'ignore', 'pipe'], timeout: 15_000, killSignal: 'SIGTERM' },
  )
}

async function ensureCloudflareCredentials({ awsCliPath, region, stage, force }) {
  for (const { envVar, param, label } of CLOUDFLARE_CREDENTIALS) {
    const name = ssmParameterName(stage, param)
    const fromEnv = process.env[envVar]
    if (fromEnv) {
      putSsmSecureParameter(awsCliPath, region, name, fromEnv)
      console.log(`[${SCRIPT_NAME}] ${label} ... set from ${envVar}`)
      continue
    }

    const exists = ssmParameterExists(awsCliPath, region, name)
    if (decideSsmOverwrite({ exists, force }) === 'skip') {
      console.log(`[${SCRIPT_NAME}] ${label} ... already set (use --force to change)`)
      continue
    }

    const value = await promptSecret(`${label}: `)
    putSsmSecureParameter(awsCliPath, region, name, value)
    console.log(`[${SCRIPT_NAME}] ${label} ... set`)
  }
}

// Routed through the same wrapper `npm run deploy`/`diff` use (not a bare sst
// call) so this stays the one place that knows how to reach the sst binary —
// see scripts/sst-with-cloudflare.mjs's own header comment for why.
async function ensureOidcClientId(stage) {
  const fromEnv = process.env.OIDC_CLIENT_ID
  const value = fromEnv ?? (await promptSecret('OIDC client ID: '))
  execFileSync(process.execPath, [SST_WRAPPER_PATH, 'secret', 'set', 'OIDC_CLIENT_ID', '--stage', stage], {
    input: value,
    encoding: 'utf8',
    stdio: ['pipe', 'inherit', 'inherit'],
    timeout: 60_000,
    killSignal: 'SIGTERM',
    cwd: INFRA_ROOT,
  })
  console.log(`[${SCRIPT_NAME}] OIDC_CLIENT_ID ... set${fromEnv ? ' from OIDC_CLIENT_ID env' : ''}`)
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
    throw new Error('the auth0 CLI is not authenticated; run `auth0 login` and complete the browser consent', { cause })
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

function deployGithubDeployRoleStack({ awsCliPath, region, stage, repo }) {
  const stackName = githubDeployRoleStackName(stage)
  const overrides = cloudFormationParameterOverrides({ repo, stage })

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

function ghSecretSetFromFile({ repo, stage, name, filePath }) {
  execFileSync('gh', ['secret', 'set', name, '--repo', repo, '--env', stage, '--body-file', filePath], {
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 30_000,
    killSignal: 'SIGTERM',
  })
}

function wireGithubEnvironment({ repo, stage, region, roleArn }) {
  ghVariableSet({ repo, stage, name: 'AWS_DEPLOY_ROLE_ARN', value: roleArn })
  ghVariableSet({ repo, stage, name: 'AWS_REGION', value: region })
  ghSecretSetFromFile({ repo, stage, name: 'DEPLOY_ENV', filePath: requireStageEnvFile() })
  console.log(`[${SCRIPT_NAME}] GitHub ${stage} environment ... AWS_DEPLOY_ROLE_ARN, AWS_REGION, DEPLOY_ENV set`)
}

async function main() {
  // Every other consumer (sst-with-cloudflare.mjs, sst.config.ts) loads the
  // stage dotenv first; without it AWS_REGION/STACK_DOMAIN from .env are
  // silently ignored and the stage lands in the default region.
  loadDeploymentEnvironment()
  const args = process.argv.slice(2)
  const stage = resolveSstStage(args)
  const force = hasFlag(args, 'force')
  const region = resolveAwsRegion()
  const awsCliPath = resolveAwsCliPath()
  const reviewerIds = parseReviewerIds(parseFlag(args, 'reviewers'))

  requireStageEnvFile()
  requireGhAuthenticated()
  const repo = resolveRepo(args)
  requireAwsCliWithLoginSupport(awsCliPath)
  const identity = currentAwsIdentity(awsCliPath, region)

  console.log(`[${SCRIPT_NAME}] stage=${stage} region=${region} repo=${repo}`)
  console.log(`[${SCRIPT_NAME}] AWS identity ... ${identity.Arn}`)

  // Default the reviewer to whoever is running this, so the environment comes
  // out actually protected rather than nominally so.
  const effectiveReviewerIds = reviewerIds.length > 0 ? reviewerIds : [authenticatedGitHubUserId()]

  ensureGitHubOidcProvider({ awsCliPath, region })
  ensureGithubEnvironment({ repo, stage, reviewerIds: effectiveReviewerIds })
  if (hasFlag(args, 'provision-auth0')) {
    const stackDomain = process.env.STACK_DOMAIN
    if (!stackDomain) throw new Error('STACK_DOMAIN must be set in .env before --provision-auth0 can build callback URLs')
    provisionAuth0({ stackDomain })
  }
  await ensureCloudflareCredentials({ awsCliPath, region, stage, force })
  await ensureOidcClientId(stage)
  const roleArn = deployGithubDeployRoleStack({ awsCliPath, region, stage, repo })
  wireGithubEnvironment({ repo, stage, region, roleArn })

  console.log(
    `[${SCRIPT_NAME}] done. Preview next: gh workflow run deploy-infra.yml --repo ${repo} --ref main -f stage=${stage} -f apply=false`,
  )
}

try {
  await main()
} catch (error) {
  console.error(`${SCRIPT_NAME}: ${error.message}`)
  process.exit(1)
}
