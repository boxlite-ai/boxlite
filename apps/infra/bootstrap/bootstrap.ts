// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/** Prepare GitHub identity, artifact stores and native Pulumi state for the selected stage. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadDeploymentEnvironment } from '../deployment/environment.js'
import {
  GITHUB_OIDC_PROVIDER_URL,
  hasGitHubOidcProvider,
  parseBootstrapOptions,
  validateGitHubRepo,
} from './environment.js'
import { ensureGithubEnvironment, parseReviewerIds } from './github.js'
import { resolveAwsCliPath } from '../shared/exec.js'
import { runAs } from './exec-run.js'
import { homeFor, loadConfig, type MstageConfig } from 'mstage/config'
import { resolveHome } from 'mstage/home'
import { resolveScope } from 'mstage/scope'
import { loadBuildConfig, registryFor } from 'mbuild/config'
import { bootstrapGcp, promotionSourceFor, type GitHubRepository } from './gcp.js'
import { bootstrapAws, nativeAwsNames } from './aws.js'
import { bootstrapAwsState } from './aws-state.js'
import { clientsFor as awsClientsFor } from 'mstage/env'

// The one stage that must never end up with an unreviewed deploy path. Matches
// PRODUCTION_STAGE in stack/settings.ts, which gates retain-on-removal.
const INFRA_ROOT = fileURLToPath(new URL('..', import.meta.url))

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

function resolveRepo(override: any) {
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
 * The deploy role's trust policy federates to this provider, but the provider
 * is account-global and CreateOpenIDConnectProvider rejects a duplicate URL
 * with EntityAlreadyExists — so detect before creating. Any account that has
 * ever wired GitHub Actions to AWS already has one. The thumbprint is
 * deliberately omitted: since July 2023 IAM validates GitHub's OIDC endpoint
 * against trusted root CAs, so pinning one would only create rotation work.
 */
function ensureGitHubOidcProvider({ awsCliPath, region, environment = process.env }: any) {
  const listOutput = JSON.parse(
    execFileSync(awsCliPath, ['iam', 'list-open-id-connect-providers', '--region', region, '--output', 'json'], {
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      killSignal: 'SIGTERM',
    }),
  )
  if (hasGitHubOidcProvider(listOutput)) {
    console.log('==> GitHub OIDC provider')
    console.log('    already registered')
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
    { env: environment, stdio: ['ignore', 'ignore', 'pipe'], timeout: 30_000, killSignal: 'SIGTERM' },
  )
  console.log('==> GitHub OIDC provider')
  console.log('    created')
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
 * The region is written alongside it: the workflows carry
 * DEFAULT_AWS_REGION as a literal default, which is only right for a stage in that region, so a stage
 * bootstrapped elsewhere needs the variable to say so.
 *
 * Per-stage, not repository-wide. Two stages may live in two AWS accounts — the deploy role is
 * created by whichever account bootstrap is pointed at — so one shared value would let bootstrapping
 * prod silently repoint dev's deploys at prod's account. The region goes the same way and for the
 * same reason as before: it is read before any AWS access exists, so it cannot come from the store,
 * and a stage outside the default region has nowhere else to say so.
 *
 * `stage` is nullable because some values genuinely are repository-wide. A
 * per-project identity is not one of them: every GCP variable below names an
 * account that exists in one project, and a shared value is the hazard this
 * comment already describes two paragraphs up.
 */
/** A repository-wide variable this bootstrap no longer writes. Absence is fine. */
function ghVariableDeleteIfPresent({ repo, name }: any) {
  try {
    execFileSync('gh', ['variable', 'delete', name, '--repo', repo], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 30_000,
      killSignal: 'SIGTERM',
    })
  } catch {
    // Never written, already removed, or not visible to this token.
  }
}

function ghEnvironmentVariableSet({ repo, stage, name, value }: any) {
  const scope = stage ? ['--env', stage] : []
  execFileSync('gh', ['variable', 'set', name, '--repo', repo, ...scope, '--body', value], {
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 30_000,
    killSignal: 'SIGTERM',
  })
}

/**
 * The numeric owner/repository ids a GCP identity provider's attribute
 * condition pins, so a rename cannot silently widen who may assume it — the
 * same property `repo:<owner>/<repo>:environment:<stage>` gets for free on
 * the AWS side from GitHub's own OIDC claim, and GCP's condition has to ask
 * for explicitly (`gcp.ts`'s `attributeCondition`).
 */
function resolveGitHubRepositoryIds(repo: any) {
  let stdout
  try {
    stdout = execFileSync(
      'gh',
      ['api', `repos/${repo}`, '--jq', '{ownerId: (.owner.id|tostring), repositoryId: (.id|tostring)}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, killSignal: 'SIGTERM' },
    )
  } catch (cause: any) {
    throw new Error(`could not read ${repo}'s numeric owner/repository ids from the GitHub API`, { cause })
  }
  return JSON.parse(stdout) as { ownerId: string; repositoryId: string }
}

/**
 * The GCP half of bootstrap, reached from `main()` below when `mstage.config.json`
 * says this stage's home is `gcp`.
 *
 * Shares three things with the AWS path rather than duplicating them:
 * `parseBootstrapOptions`'s flags, the GitHub Environment + reviewer
 * protection (`ensureGithubEnvironment`), and the variable-writing convention
 * (`ghEnvironmentVariableSet`) — none of the three are AWS-specific, and a
 * second copy of any would drift the moment one changed and not the other.
 * Everything GCP-specific — the APIs, the state bucket, the identity pool, the
 * service accounts, the registry — lives in gcp.ts instead.
 */
async function bootstrapGcpStage({
  stage,
  options,
  config,
}: {
  stage: string
  options: any
  config: MstageConfig
}): Promise<void> {
  const declared = config.stages[stage]
  if (declared.protect && options.confirm !== true) {
    throw new Error(`Stage "${stage}" is protected in ${config.path}. Add --confirm to bootstrap it.`)
  }
  if (!declared.project) throw new Error(`Stage "${stage}" declares no project in ${config.path}`)
  if (!declared.region) throw new Error(`Stage "${stage}" declares no region in ${config.path}`)

  requireGhAuthenticated()
  const repo = resolveRepo(options.repo)
  const reviewerIds = parseReviewerIds(options.reviewers)
  const effectiveReviewerIds = reviewerIds.length > 0 ? reviewerIds : [authenticatedGitHubUserId()]

  console.log(`stage=${stage} home=gcp project=${declared.project} region=${declared.region} repo=${repo}`)
  ensureGithubEnvironment({ repo, stage, reviewerIds: effectiveReviewerIds })

  const [owner, repositoryName] = repo.split('/')
  const { ownerId, repositoryId } = resolveGitHubRepositoryIds(repo)
  const github: GitHubRepository = {
    issuer: GITHUB_OIDC_PROVIDER_URL,
    owner,
    ownerId,
    repository: repositoryName,
    repositoryId,
  }

  const buildConfig = loadBuildConfig({ cwd: INFRA_ROOT, environment: process.env })
  const registry = registryFor(buildConfig, stage)
  if (registry.kind !== 'artifact-registry') {
    throw new Error(
      `Stage "${stage}" publishes to ${registry.kind} in ${buildConfig.path}; a GCP bootstrap creates an Artifact Registry repository`,
    )
  }

  /*
   * Every gcloud call in the GCP bootstrap, run as the identity mstage resolved.
   *
   * Borrowed rather than assembled here, and that is the point: `mstage login`
   * verifies Application Default Credentials, `childEnvironment` is what hands
   * them to a subprocess, and a second answer composed in this file is a second
   * thing that can disagree with the check an operator just ran. It also clears
   * every AWS variable, so a stale key triple in this shell cannot send a GCP
   * bootstrap at the other cloud.
   *
   * `resolveHome` is safe on a project this has not bootstrapped yet: it builds
   * clients and an identity, and the state bucket it could not find is behind a
   * function nothing here calls.
   *
   * Wrapped here rather than inside `gcp.ts` because that file takes a `Run` so
   * a test can drive it without a CLI at all; which credential a real run uses
   * is this composition point's business.
   */
  const scope = resolveScope({ options: { stage }, config, environment: process.env })
  const { identity } = await resolveHome({ scope })
  const { env: credentials } = await identity.childEnvironment()

  const result = await bootstrapGcp({
    run: runAs(credentials),
    project: declared.project,
    region: declared.region,
    app: config.app,
    appShort: config.appShort,
    stage,
    repository: registry.repository,
    // The same declaration mbuild reads. It can only be honoured at creation,
    // and mbuild refuses to publish into a repository that contradicts it.
    immutableTags: buildConfig.stages[stage]!.registry.immutableTags,
    github,
    promotionSource: promotionSourceFor({ config, stage }),
    log: console.log,
  })

  // Written the same way wireGithubEnvironment writes the AWS pair: bootstrap
  // wires CI at what it just made rather than asking the operator to paste it.
  ghEnvironmentVariableSet({
    repo,
    stage,
    name: 'GCP_WORKLOAD_IDENTITY_PROVIDER',
    value: result.workloadIdentityProvider,
  })
  ghEnvironmentVariableSet({ repo, stage, name: 'GCP_DEPLOYER', value: result.deployerEmail })
  /*
   * Per environment, like the two above it.
   *
   * This was repository-wide on the grounds that mbuild.yml's publish job runs
   * before a stage-specific environment would apply. That job declares
   * `environment: ${{ inputs.stage || inputs.to }}` and is the only reader, so
   * the grounds were never true — and the publisher lives in the stage's own
   * project, so one shared value meant whichever stage bootstrapped last owned
   * it. Bootstrapping prod pointed dev's publish at
   * `bl-app-publish@boxlite-prod-project`, which the dev pool cannot
   * impersonate: `Permission 'iam.serviceAccounts.getAccessToken' denied`,
   * three attempts, after every image had been built.
   */
  ghEnvironmentVariableSet({ repo, stage, name: 'GCP_IMAGE_PUBLISHER', value: result.publisherEmail })
  // The shared one it replaces, removed rather than left to shadow nothing: a
  // stale account id sitting where this used to be read is the next hour lost
  // to the same error. Absent already is the normal case, so a failure here is
  // not one.
  ghVariableDeleteIfPresent({ repo, name: 'GCP_IMAGE_PUBLISHER' })
  console.log(`==> GitHub ${stage} environment`)
  console.log('    GCP_WORKLOAD_IDENTITY_PROVIDER, GCP_DEPLOYER, GCP_IMAGE_PUBLISHER set')

  console.log(
    `done. Preview next: gh workflow run mdeploy-all.yml --repo ${repo} --ref main -f stage=${stage} -f apply=false`,
  )
}

/** Native AWS follows the same prerequisite-only bootstrap contract as GCP. */
async function bootstrapNativeAwsStage({
  stage,
  options,
  config,
}: {
  stage: string
  options: any
  config: MstageConfig
}): Promise<void> {
  const declared = config.stages[stage]
  if (declared.protect && !options.confirm)
    throw new Error(`Stage "${stage}" is protected. Add --confirm to bootstrap it.`)
  if (options['provision-auth0'] || options['provision-ses']) {
    throw new Error(
      'Native bootstrap uses secret ARNs configured with mstage; provision-auth0/provision-ses require separately provisioned services',
    )
  }
  const scope = resolveScope({ options: { stage }, config, environment: process.env })
  const home = await resolveHome({ scope })
  if (home.identity.home !== 'aws') throw new Error('Native AWS bootstrap requires an AWS stage')
  const { env: credentials } = await home.identity.childEnvironment()
  const caller = await home.identity.whoami()
  if (!caller.tenant) throw new Error('AWS identity returned no account ID')
  nativeAwsNames({ app: config.app, stage, accountId: caller.tenant })
  const buildConfig = loadBuildConfig({ cwd: INFRA_ROOT, environment: process.env })
  const registry = registryFor(buildConfig, stage)
  if (registry.kind !== 'ecr') throw new Error('An AWS stage needs an ECR registry declaration')
  let promotionSource
  if (declared.promoteFrom) {
    const source = config.stages[declared.promoteFrom]
    const sourceRegistry = registryFor(buildConfig, declared.promoteFrom)
    if (sourceRegistry.kind !== 'ecr' || !source.region)
      throw new Error('AWS promotion needs an ECR source stage with a region')
    promotionSource = { stage: declared.promoteFrom, region: source.region, repository: sourceRegistry.repository }
  }
  const deployment = declared.deploy as { storage?: { volumePrefix?: string } } | undefined
  const volumePrefix = deployment?.storage?.volumePrefix ?? 'boxlite-volume'
  if (!/^[a-z0-9][a-z0-9-]{1,45}$/.test(volumePrefix)) throw new Error('Invalid AWS volume bucket prefix')
  requireGhAuthenticated()
  const repo = resolveRepo(options.repo)
  const reviewers = parseReviewerIds(options.reviewers)
  ensureGithubEnvironment({ repo, stage, reviewerIds: reviewers.length ? reviewers : [authenticatedGitHubUserId()] })
  ensureGitHubOidcProvider({ awsCliPath: resolveAwsCliPath(), region: scope.region, environment: credentials })
  const stateBucket = await bootstrapAwsState({
    clients: awsClientsFor(home.identity),
    app: config.app,
    stage,
    accountId: caller.tenant,
    region: scope.region,
  })
  const result = await bootstrapAws({
    run: runAs(credentials),
    repo,
    stage,
    accountId: caller.tenant,
    region: scope.region,
    log: console.log,
    native: {
      app: config.app,
      repository: registry.repository,
      promotionSource,
      volumePrefix,
      stateBucket,
      immutableTags: registry.immutableTags,
      scanOnPush: registry.scanOnPush,
    },
  })
  ghEnvironmentVariableSet({ repo, stage, name: 'AWS_ACCOUNT_ID', value: caller.tenant })
  ghEnvironmentVariableSet({ repo, stage, name: 'AWS_REGION', value: scope.region })
  ghEnvironmentVariableSet({ repo, stage, name: 'AWS_PULUMI_DEPLOY_ROLE_ARN', value: result.roleArn })
  console.log(
    'Native AWS prerequisites ready. Configure declared mstage environment groups and secret ARNs before previewing.',
  )
}

async function main() {
  loadDeploymentEnvironment()
  const options = parseBootstrapOptions(process.argv.slice(2))
  const stage = options.stage ?? 'dev'
  const mstageConfig = loadConfig({ cwd: INFRA_ROOT, environment: process.env })
  if (homeFor(mstageConfig, stage) === 'gcp') {
    return await bootstrapGcpStage({ stage, options, config: mstageConfig })
  }
  return bootstrapNativeAwsStage({ stage, options, config: mstageConfig })
}

try {
  await main()
} catch (error: any) {
  // Print the cause chain. Several checks here wrap a tool failure in advice
  // ("GitHub CLI is not authenticated; run `npm run login` first"), and the
  // advice is only right for one of the ways that tool can fail — `gh auth
  // status` also exits non-zero when it cannot reach github.com. Without the
  // cause an operator whose session is fine is sent to re-authenticate.
  console.error(error.message)
  for (let cause = error.cause; cause; cause = cause.cause) {
    console.error(`  caused by: ${cause.message ?? cause}`)
  }
  process.exit(1)
}
