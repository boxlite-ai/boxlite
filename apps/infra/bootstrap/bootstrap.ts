// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Idempotent, human-run environment preparation for a BoxLite SST
 * deployment: the GitHub OIDC deploy role + runtime IAM boundary
 * (bootstrap/aws/github-deploy-role.yaml), the GitHub `<stage>` Environment the
 * deploy workflow binds to, the Cloudflare provider credentials in SSM, and the
 * stage's own configuration — OIDC_CLIENT_ID, and every key from .env that is not
 * local-only (deployableStageConfig) — in its SST secret store.
 *
 * Four things are written on the GitHub side, all on the stage's own Environment
 * rather than the repository, so two stages never share them: the variables
 * AWS_ACCOUNT_ID and AWS_REGION, and the secrets CLOUDFLARE_API_TOKEN and
 * CLOUDFLARE_DEFAULT_ACCOUNT_ID. None of the four can come from the store: the
 * workflow composes the deploy role ARN from the account id before any AWS
 * credentials exist, and reading the store initializes the Cloudflare provider, so
 * a token kept there would be needed in order to read itself.
 *
 * A local deploy reads the Cloudflare pair from SSM instead — or straight from
 * .env, which wins over both, along with the rest of the local-only keys
 * (deployment/sst.ts). Everything else, either way, comes from the store.
 *
 * See apps/infra/README.md's
 * "Deploy an existing stack" section for the full prerequisite list this
 * script does NOT cover (Cloudflare domain, Auth0/OIDC tenant, an existing
 * Runner — first-Runner provisioning is a separate, not-yet-built operation).
 *
 * Safe to re-run any number of times: every step reconciles to the desired
 * state instead of failing on "already exists". Requires AWS credentials
 * with IAM/SSM/CloudFormation access — deliberately NOT the scoped deploy
 * role this script provisions, which cannot touch CloudFormation or its own
 * IAM policy by design (see the CreateBoundedBoxLiteRoles /
 * SetBoxLiteRoleBoundary statements in bootstrap/aws/github-deploy-role.yaml) — and a
 * `gh` CLI authenticated against the target repo.
 *
 * Usage: npm run bootstrap -- [--stage dev] [--repo owner/name]
 *                                               [--reviewers 123,456] [--force]
 *   --stage      SST stage to bootstrap (default: dev, or SST_STAGE). The GitHub
 *                Environment must be named exactly this — the deploy role's trust
 *                policy pins `repo:<owner>/<repo>:environment:<stage>`.
 *   --repo       GitHub repo as owner/name (default: `gh repo view` in this checkout —
 *                a community fork resolves to itself automatically)
 *   --reviewers  Comma-separated numeric GitHub user ids required to approve a
 *                deployment (default: whoever is authenticated with `gh`)
 *   --force      re-prompt for a Cloudflare credential that is already seeded
 *                (decideCredentialRotation() in bootstrap/cloudflare-credentials.ts)
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
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { hasFlag, parseFlag } from '../shared/cli-flags.js'
import { decideCredentialRotation, writeCloudflareCredential } from './cloudflare-credentials.js'
import { withStageConfigFile } from './stage-config-file.js'
import { loadDeploymentEnvironment, resolveAwsRegion } from '../deployment/environment.js'
import {
  GITHUB_OIDC_PROVIDER_URL,
  MINIMUM_AWS_CLI_VERSION,
  cloudFormationDeployChanged,
  cloudFormationParameterOverrides,
  githubDeployRoleStackName,
  hasGitHubOidcProvider,
  isAwsCliVersionAtLeast,
  prepareStageConfigLoad,
  serializeStageConfig,
  ssmParameterName,
  sstPlatformState,
  validateGitHubRepo,
} from './environment.js'
import { validateDotenvSyntax } from '../deployment/validate-environment.js'
import {
  bindActionArgs,
  createActionArgs,
  customApiArgs,
  deployActionArgs,
  enableRpLogoutDiscoveryArgs,
  spaApplicationArgs,
} from './auth0.js'
import {
  environmentApiPath,
  githubEnvironmentPayload,
  isProtectionUnavailableError,
  parseReviewerIds,
} from './github.js'
import { resolveAwsCliPath } from '../shared/aws-cli.js'
import { resolveSstStage } from '../deployment/stage.js'

const SCRIPT_NAME = 'bootstrap-environment'
// The one stage that must never end up with an unreviewed deploy path. Matches
// PRODUCTION_STAGE in sst.config.ts, which gates retain-on-removal.
const PROTECTED_STAGE = 'prod'
const INFRA_ROOT = fileURLToPath(new URL('..', import.meta.url))
const TEMPLATE_PATH = join(INFRA_ROOT, 'bootstrap', 'aws', 'github-deploy-role.yaml')
const ENV_PATH = join(INFRA_ROOT, '.env')
const SST_WRAPPER_PATH = join(INFRA_ROOT, 'deployment', 'sst.ts')
// Generous but bounded: a healthy platform install completed in ~85s here.
const SST_INSTALL_TIMEOUT_MS = 240_000
// The cold attempt gets a shorter leash than that, because a recovery sits
// behind it: giving up early costs at worst an npm install that would not have
// been needed, while waiting the full budget on an install that is not
// progressing costs four minutes of silence.
const SST_COLD_INSTALL_TIMEOUT_MS = 90_000
const ACTION_SOURCE_PATH = join(INFRA_ROOT, 'bootstrap', 'auth0', 'set-custom-claims.js')

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

function requireStageEnvFile() {
  if (!existsSync(ENV_PATH)) {
    throw new Error(`${ENV_PATH} does not exist; run \`cp .env.example .env\` and fill it in first`)
  }
  return ENV_PATH
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
  } catch (cause: any) {
    const detail = cause.stderr?.trim()
    throw new Error(
      `GitHub CLI is not authenticated; run \`npm run login\` first${detail ? ` (gh said: ${detail})` : ''}`,
      { cause },
    )
  }
}

function resolveRepo(args: any) {
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
function requireAwsCliWithLoginSupport(awsCliPath: any) {
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

function currentAwsIdentity(awsCliPath: any, region: any) {
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
function requireNonEmptySecret(label: any, value: any) {
  const trimmed = value?.trim()
  if (!trimmed) throw new Error(`${label} cannot be empty`)
  return trimmed
}

// No native masked-input in node:readline — a minimal raw-mode reader avoids
// pulling in a prompt dependency for two secrets. TTY-gated: a non-interactive
// caller (CI, a script) must supply the value through the matching env var
// instead of hanging on a prompt that can never be answered.
function promptSecret(label: any) {
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
    const onData = (chunk: any) => {
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

function ssmParameterExists(awsCliPath: any, region: any, name: any) {
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

function putSsmSecureParameter(awsCliPath: any, region: any, name: any, value: any) {
  execFileSync(
    awsCliPath,
    ['ssm', 'put-parameter', '--region', region, '--type', 'SecureString', '--name', name, '--value', 'file:///dev/stdin', '--overwrite'],
    { input: value, encoding: 'utf8', stdio: ['pipe', 'ignore', 'pipe'], timeout: 15_000, killSignal: 'SIGTERM' },
  )
}

function setStageSecret({ stage, name, value }: any) {
  // 120s, not 60s: this writes to the stage's secret store over the network, and a slow link should
  // not look like a broken one. The value goes in on stdin — never in argv, where another process
  // on the machine could read it.
  runSst(['secret', 'set', name, '--stage', stage], {
    input: value,
    timeout: 120_000,
    label: `set the ${name} secret`,
  })
}

/*
 * The Cloudflare provider credentials, in SSM rather than the stage's SST secret store with
 * everything else.
 *
 * Not an oversight and not inertia: reading the SST store initializes every provider sst.config.ts
 * declares, Cloudflare included, so `sst secret list` exits with "Cloudflare API not initialized"
 * before printing anything. A token kept there would be required in order to read itself.
 *
 * The deploy workflow does not use these parameters either; it supplies the same two values as
 * Environment secrets. Whether it could read them instead is untested — see the note in
 * deployment/sst.ts.
 */
async function ensureCloudflareCredentials({ awsCliPath, region, stage, repo, force }: any) {
  for (const { envVar, param, label } of CLOUDFLARE_CREDENTIALS) {
    const name = ssmParameterName(stage, param)
    const fromEnv = process.env[envVar]?.trim()
    if (fromEnv) {
      storeCloudflareCredential({ awsCliPath, region, stage, repo, name, envVar, value: fromEnv })
      console.log(`[${SCRIPT_NAME}] ${label} ... set from ${envVar}`)
      continue
    }

    // Both destinations, not just SSM: a rerun has to be able to repair a pair torn by a failed
    // GitHub write, and keying this on SSM alone made that state permanent.
    const rotation = decideCredentialRotation({
      parameterExists: ssmParameterExists(awsCliPath, region, name),
      environmentSecretExists: ghEnvironmentSecretExists({ repo, stage, name: envVar }),
      force,
    })
    if (rotation === 'skip') {
      console.log(`[${SCRIPT_NAME}] ${label} ... already set in both stores (use --force to change)`)
      continue
    }

    const value = requireNonEmptySecret(label, await promptSecret(`${label}: `))
    storeCloudflareCredential({ awsCliPath, region, stage, repo, name, envVar, value })
    console.log(`[${SCRIPT_NAME}] ${label} ... set`)
  }
}

/*
 * Whether the stage's Environment already holds this secret. Only presence — GitHub never returns a
 * secret's value — which is what decideCredentialRotation needs to spot a half-written pair.
 */
function ghEnvironmentSecretExists({ repo, stage, name }: any) {
  try {
    const listed = execFileSync('gh', ['secret', 'list', '--repo', repo, '--env', stage, '--json', 'name'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      killSignal: 'SIGTERM',
    })
    return JSON.parse(listed).some((secret: any) => secret.name === name)
  } catch {
    // Unreadable is treated as absent, which biases toward writing. Costing a retyped token is the
    // right way to be wrong here; the opposite mistake leaves a revoked credential in place.
    return false
  }
}

function ghEnvironmentSecretSet({ repo, stage, name, value }: any) {
  // The value on stdin, never in argv, where any process on the machine could read it from /proc.
  execFileSync('gh', ['secret', 'set', name, '--repo', repo, '--env', stage], {
    input: value,
    stdio: ['pipe', 'inherit', 'inherit'],
    timeout: 30_000,
    killSignal: 'SIGTERM',
  })
}

// The rule about which destinations get a rotated credential lives in cloudflare-credentials.ts, so
// it is reachable from a test; this only supplies the two writers.
function storeCloudflareCredential({ awsCliPath, region, stage, repo, name, envVar, value }: any) {
  writeCloudflareCredential(value, {
    writeParameter: (stored: string) => putSsmSecureParameter(awsCliPath, region, name, stored),
    writeEnvironmentSecret: (stored: string) => ghEnvironmentSecretSet({ repo, stage, name: envVar, value: stored }),
  })
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
function ensureSstPlatform(stage: any) {
  if (sstPlatformState(SST_PLATFORM_DIR) === 'ready') {
    runSst(['install', '--stage', stage], {
      timeout: SST_INSTALL_TIMEOUT_MS,
      label: 'install the SST platform',
    })
    console.log(`[${SCRIPT_NAME}] SST platform ... ready`)
    return
  }

  console.log(`[${SCRIPT_NAME}] SST platform ... installing (first run: pulumi + providers, a minute or two)`)
  try {
    runSst(['install', '--stage', stage], {
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
    runSst(['install', '--stage', stage], {
      timeout: SST_INSTALL_TIMEOUT_MS,
      label: 'install the SST platform',
    })
  }
  console.log(`[${SCRIPT_NAME}] SST platform ... ready`)
}

/*
 * Every sst call goes through the wrapper `npm run deploy`/`diff` use (not a
 * bare sst binary) so this stays the one place that knows how to reach it —
 * see deployment/sst.ts's own header comment for why.
 *
 * sst writes its own diagnosis to .sst/log/sst.log and prints only "Unexpected
 * error occurred" to the terminal, so a failure here is worthless without that
 * file — which is why the error names its path.
 */
/*
 * A failure names the sst log rather than quoting it.
 *
 * sst writes provider diagnostics to .sst/log/sst.log, in most detail exactly when a call fails —
 * request bodies included. This script hands sst an app secret (`secret set`) and a stage's entire
 * configuration (`secret load`), so quoting that file into an error message puts those values in the
 * operator's terminal and whatever collects it.
 *
 * Gating it per call does not work, which is the version this replaced: the log persists across calls,
 * so a later `install` failure would quote lines an earlier `secret load` had written. The file is
 * one line away for anyone debugging, and printing the path costs them nothing.
 */
function runSst(args: any, { input, timeout, label }: { input?: string; timeout: number; label: string }) {
  try {
    execFileSync(process.execPath, ['--import', 'tsx', SST_WRAPPER_PATH, ...args], {
      ...(input === undefined ? {} : { input }),
      encoding: 'utf8',
      stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'],
      timeout,
      killSignal: 'SIGTERM',
      cwd: INFRA_ROOT,
    })
  } catch (cause: any) {
    const hint = cause.code === 'ETIMEDOUT' ? ` after ${Math.round(timeout / 1000)}s` : ''
    const detail = `\n  see ${join(INFRA_ROOT, '.sst', 'log', 'sst.log')}`
    throw new Error(`could not ${label}${hint}${detail}`, { cause })
  }
}


async function ensureOidcClientId(stage: any) {
  // `?.trim() || undefined` rather than `??`: an env var set to the empty
  // string is a misconfiguration, not a choice to store nothing, and `??` would
  // accept it and seed an empty secret that only fails at deploy time.
  const fromEnv = process.env.OIDC_CLIENT_ID?.trim() || undefined
  const value = requireNonEmptySecret('OIDC client ID', fromEnv ?? (await promptSecret('OIDC client ID: ')))
  setStageSecret({ stage, name: 'OIDC_CLIENT_ID', value })
  console.log(`[${SCRIPT_NAME}] OIDC_CLIENT_ID ... set${fromEnv ? ' from OIDC_CLIENT_ID env' : ''}`)
}

/*
 * Put the stage's configuration where a deploy can read it with nothing but AWS credentials.
 *
 * This same .env used to travel to CI as the GitHub Environment secret DEPLOY_ENV, which put stage
 * config in a second control plane: a repository administrator could change what gets deployed with
 * no AWS access at all, and offboarding meant revoking both. The SST secret store is reachable by
 * exactly the people who can already deploy the stage.
 *
 * So deployment/sst.ts reads this store before it invokes sst, and the only stage configuration left
 * on the GitHub side is what cannot be read from the store at all: the AWS_ACCOUNT_ID and AWS_REGION
 * variables, needed before any AWS credentials exist, and the two Cloudflare secrets, needed in order
 * to read the store.
 *
 * One secret per key, not the file as a single blob. A blob would be the DEPLOY_ENV design again —
 * replaceable only wholesale, invisible to `npm run secrets` — and it would have to carry newlines,
 * which serializeStageConfig cannot represent. Per-key also keeps `sst.Secret` usable: the store
 * already holds OIDC_CLIENT_ID and friends under their own names (stack/deploy.ts).
 *
 * `sst secret load` merges into the stage's existing secrets rather than replacing them, which is
 * what keeps this from clobbering those. The cost of merging is that a key REMOVED from .env stays in
 * the store, so the manifest written alongside the values — STAGE_CONFIG_MANIFEST_KEY, naming exactly
 * the keys this step owns — is what makes the leftover inert: deployment/sst.ts hydrates only the
 * names the manifest lists. That is also why the manifest cannot simply be "everything in the store":
 * the same store holds the hand-set `sst.Secret` values, which the stack reads through sst.Secret and
 * must never see as process.env.
 */
/*
 * Takes the already-prepared load rather than reading .env again.
 *
 * main() validates one snapshot of the file before anything external happens, and this runs after the
 * OIDC provider, the GitHub Environment and possibly an Auth0 app have been created — minutes later on
 * a first bootstrap. Re-reading would store whatever the file says by then, which is not what was
 * validated: an operator editing it while the script runs, or a half-saved buffer, would land in the
 * stage's store unchecked. One read, one validation, one thing stored.
 *
 * The Cloudflare credentials are deliberately not part of this: reading the store initializes the
 * Cloudflare provider, so a token kept there would be needed in order to read itself. They go to SSM
 * and the GitHub Environment instead (storeCloudflareCredential).
 */
function ensureStageConfig(stage: any, { payload: config, storedKeys, excluded }: any) {
  // A temp file, because `secret load` takes a path and has no stdin form. It gets a directory of
  // its own so mkdtemp's 0700 keeps the values unreadable to other users for the seconds they
  // exist, and the removal is in `finally` so a failed load does not leave them behind.
  withStageConfigFile(config, (configPath: string) =>
    runSst(['secret', 'load', configPath, '--stage', stage], {
      timeout: 120_000,
      label: 'load the stage configuration into the SST secret store',
    }),
  )

  console.log(`[${SCRIPT_NAME}] stage config ... ${storedKeys.length} keys in the SST secret store`)
  if (excluded.length > 0) {
    console.log(`[${SCRIPT_NAME}] stage config ... kept out of the store (local-only): ${excluded.join(', ')}`)
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
function ensureGitHubOidcProvider({ awsCliPath, region }: any) {
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
function ensureGithubEnvironment({ repo, stage, reviewerIds }: any) {
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
  } catch (error: any) {
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

function auth0Json(args: any) {
  return JSON.parse(
    execFileSync('auth0', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      killSignal: 'SIGTERM',
    }),
  )
}

function auth0Run(args: any) {
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
function provisionAuth0({ stackDomain }: any) {
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

function deployGithubDeployRoleStack({ awsCliPath, region, stage, repo }: any) {
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

/*
 * The two variables written on GitHub's side — AWS_ACCOUNT_ID, which a deploy cannot do without, and
 * AWS_REGION, which only a stage outside the default region needs — and why neither can live in the
 * store. Bootstrap writes both regardless: it knows the region it just deployed into, and stating it
 * explicitly costs nothing, while leaving it to the workflows' literal default is silently wrong for
 * exactly the stage that is hardest to debug.
 *
 * (The stage's Environment also carries the two Cloudflare secrets — storeCloudflareCredential — for
 * a different reason: reading the store initializes that provider.)
 *
 * `aws-actions/configure-aws-credentials` needs the role ARN to obtain credentials, so it is read
 * before any AWS access exists — which rules out a store that AWS credentials decrypt. Only the
 * account id is genuinely unknown, though: the role name is githubDeployRoleName(stage), so the
 * workflows compose the ARN from AWS_ACCOUNT_ID rather than storing the whole ARN.
 * Same shape e2e-local.yml:89 already uses. The region is written alongside it: the workflows carry
 * DEFAULT_AWS_REGION as a literal default, which is only right for a stage in that region, so a stage
 * bootstrapped elsewhere needs the variable to say so.
 *
 * Per-stage, not repository-wide. Two stages may live in two AWS accounts — the deploy role is
 * created by whichever account bootstrap is pointed at — so one shared value would let bootstrapping
 * prod silently repoint dev's deploys at prod's account. The region goes the same way and for the
 * same reason as before: it is read before any AWS access exists, so it cannot come from the store,
 * and a stage outside the default region has nowhere else to say so.
 */
function ghEnvironmentVariableSet({ repo, stage, name, value }: any) {
  execFileSync('gh', ['variable', 'set', name, '--repo', repo, '--env', stage, '--body', value], {
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 30_000,
    killSignal: 'SIGTERM',
  })
}

function wireGithubEnvironment({ repo, stage, accountId, region }: any) {
  ghEnvironmentVariableSet({ repo, stage, name: 'AWS_ACCOUNT_ID', value: accountId })
  ghEnvironmentVariableSet({ repo, stage, name: 'AWS_REGION', value: region })
  console.log(`[${SCRIPT_NAME}] GitHub ${stage} environment ... AWS_ACCOUNT_ID, AWS_REGION set`)
}

async function main() {
  // Every other consumer (deployment/sst.ts, sst.config.ts) loads the
  // stage dotenv first; without it AWS_REGION/STACK_DOMAIN from .env are
  // silently ignored and the stage lands in the default region.
  loadDeploymentEnvironment()
  const args = process.argv.slice(2)
  const stage = resolveSstStage(args)
  const force = hasFlag(args, 'force')
  const region = resolveAwsRegion()
  const awsCliPath = resolveAwsCliPath()
  const reviewerIds = parseReviewerIds(parseFlag(args, 'reviewers'))

  // Before any external mutation. Every step below creates or changes something outside this process
  // — an OIDC provider, a GitHub Environment, optionally a non-idempotent Auth0 app — so a .env this
  // step could not store must stop the run here rather than after half of them have happened. All
  // three checks for that reason, not just the syntax: prepareStageConfigLoad rejects a file with
  // nothing storable in it, and serializeStageConfig a value the store cannot carry.
  //
  // The result is kept and handed to ensureStageConfig later, so what gets stored is exactly what was
  // checked here — the file is read once, not again after those external changes have happened.
  const stageConfigSource = readFileSync(requireStageEnvFile(), 'utf8')
  validateDotenvSyntax(stageConfigSource, ENV_PATH)
  let stageConfigLoad
  try {
    stageConfigLoad = prepareStageConfigLoad(stageConfigSource)
    serializeStageConfig(stageConfigLoad.payload)
  } catch (cause: any) {
    throw new Error(`${ENV_PATH} ${cause.message}`, { cause })
  }
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
    /*
     * From the snapshot that is about to be stored, not from process.env.
     *
     * loadDeploymentEnvironment() leaves an exported STACK_DOMAIN in place — a shell override wins
     * over the file — so reading it here would build Auth0 callback URLs for one domain while the
     * store, and therefore every deploy, used another. The two would disagree with nothing to say so,
     * and Auth0 provisioning is not idempotent, so the wrong URLs are not simply re-run away.
     */
    const stackDomain = stageConfigLoad.payload.STACK_DOMAIN
    if (!stackDomain) {
      throw new Error(`STACK_DOMAIN must be set in ${ENV_PATH} before --provision-auth0 can build callback URLs`)
    }
    provisionAuth0({ stackDomain })
  }
  await ensureCloudflareCredentials({ awsCliPath, region, stage, repo, force })
  // Before the first timed sst call, not inside it — see ensureSstPlatform. Both steps below are
  // `sst secret` calls, so neither can run until the platform sst needs is installed.
  ensureSstPlatform(stage)
  await ensureOidcClientId(stage)
  ensureStageConfig(stage, stageConfigLoad)
  // The role is deployed after the store is seeded so a failure here leaves a stage that is
  // configured but not yet deployable, rather than one the workflow can reach with no configuration.
  deployGithubDeployRoleStack({ awsCliPath, region, stage, repo })
  wireGithubEnvironment({ repo, stage, accountId: identity.Account, region })

  console.log(
    `[${SCRIPT_NAME}] done. Preview next: gh workflow run deploy-infra.yml --repo ${repo} --ref main -f stage=${stage} -f apply=false`,
  )
  // Not deleted here on purpose. Until this branch is merged, the deploy workflow on main still reads
  // DEPLOY_ENV, so removing it would break deploys of every commit that predates the store. Printed
  // rather than silently left behind, because a stale DEPLOY_ENV is invisible once it stops being read.
  console.log(
    `[${SCRIPT_NAME}] after the first green apply, retire the superseded GitHub entries:\n` +
      `  gh secret delete DEPLOY_ENV --repo ${repo} --env ${stage}\n` +
      `  gh variable delete AWS_DEPLOY_ROLE_ARN --repo ${repo} --env ${stage}`,
  )
}

try {
  await main()
} catch (error: any) {
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
