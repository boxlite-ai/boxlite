// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/** Bootstrap provisions the GitHub deploy role, the boundary applied by native Pulumi and the stage's artifact stores. */

import { stageDataBucketName } from '../mdeploy/stack/providers/aws/bucket-names.ts'
import { runnerArtifactsBucket } from '../mdeploy/stack/runner-binary.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export class AwsBootstrapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AwsBootstrapError'
  }
}

/** One external command. A non-zero exit is reported, never thrown away. */
export type RunResult = { code: number; stdout: string; stderr: string }
export type RunOptions = { stdin?: string }
export type Run = (command: string, args: string[], options?: RunOptions) => Promise<RunResult>

/** The documents live beside this file; this module is an implementation of them. */
const DOCUMENTS = fileURLToPath(new URL('./aws', import.meta.url))

// Matches the CFN template's MaxSessionDuration. A soak deploy needs the full two hours; an
// ordinary one finishes in a fraction of it, so there is no cost to granting it every time.
const DEPLOY_SESSION_DURATION_SECONDS = '7200'

// A managed policy caps at 5 versions; create-policy-version fails LimitExceeded on the 6th
// unless an old, non-default one is pruned first. See ensureRuntimeBoundary.
const MANAGED_POLICY_VERSION_LIMIT = 5

type NativeBootstrap = {
  app: string
  repository: string
  volumePrefix: string
  stateBucket: string
  promotionSource?: { stage: string; region: string; repository: string }
  immutableTags?: boolean
  scanOnPush?: boolean
}
type DocumentScope = { repo: string; stage: string; accountId: string; region: string; native: NativeBootstrap }

export const nativeAwsNames = ({ app, stage, accountId }: { app: string; stage: string; accountId: string }) => {
  const roleName = `${app}-${stage}-pulumi-deploy`
  const bucketName = runnerArtifactsBucket({ app, stage, accountId })
  if (
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(app) ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(stage) ||
    !/^[0-9]{12}$/.test(accountId) ||
    (app + '-' + stage + '-').length > 28 ||
    roleName.length > 64 ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucketName)
  ) {
    throw new AwsBootstrapError('App, stage and account must produce valid native AWS role and artifact bucket names')
  }
  return { roleName, bucketName }
}

/**
 * Renders one of the JSON documents in `aws/` for one repository, stage,
 * account and region.
 *
 * The account and region are placeholders for the same reason the stage is: a
 * literal in the file is a second declaration to keep in step with the
 * credentials actually creating the role, and disagreement fails as a grant
 * made in the wrong place rather than as a visible error.
 *
 * Exported because the useful assertion is that a real document comes out of
 * this with nothing left to substitute.
 */
export const render = (contents: string, { repo, stage, accountId, region, native }: DocumentScope): string =>
  contents
    .replaceAll('<REPO>', repo)
    .replaceAll('<STAGE>', stage)
    .replaceAll('<ACCOUNT>', accountId)
    .replaceAll('<REGION>', region)
    .replaceAll('<APP>', native.app)
    .replaceAll('<ECR_REPOSITORY>', native.repository)
    .replaceAll('<VOLUME_PREFIX>', native.volumePrefix)
    .replaceAll('<STATE_BUCKET>', native.stateBucket)
    .replaceAll('<ARTIFACT_BUCKET>', runnerArtifactsBucket({ app: native.app, stage, accountId }))
    .replaceAll('<STORAGE_BUCKET>', stageDataBucketName(native.app, stage, accountId, 'storage'))
    .replaceAll('<CHECKPOINT_BUCKET>', stageDataBucketName(native.app, stage, accountId, 'checkpoints'))

const documentFor = (file: string, scope: DocumentScope): string => {
  let contents: string
  try {
    contents = readFileSync(join(DOCUMENTS, file !== 'deploy-role-trust.json' ? 'native-' + file : file), 'utf8')
  } catch (error) {
    throw new AwsBootstrapError(`Could not read bootstrap/aws/${file}: ${(error as Error).message}`)
  }
  const rendered = render(contents, scope)
  const source = scope.native.promotionSource
  if (!source || file !== 'deploy-role-policy.json') return rendered

  const bucket = nativeAwsNames({ app: scope.native.app, stage: source.stage, accountId: scope.accountId }).bucketName
  const policy = JSON.parse(rendered)
  policy.Statement.push(
    {
      Sid: 'ReadPromotionImages',
      Effect: 'Allow',
      Action: [
        'ecr:DescribeImages',
        'ecr:BatchCheckLayerAvailability',
        'ecr:BatchGetImage',
        'ecr:GetDownloadUrlForLayer',
      ],
      Resource: `arn:aws:ecr:${source.region}:${scope.accountId}:repository/${source.repository}`,
    },
    {
      Sid: 'ListPromotionArtifacts',
      Effect: 'Allow',
      Action: 's3:ListBucket',
      Resource: `arn:aws:s3:::${bucket}`,
      Condition: { StringLike: { 's3:prefix': 'runner/*' } },
    },
    {
      Sid: 'ReadPromotionArtifacts',
      Effect: 'Allow',
      Action: 's3:GetObject',
      Resource: `arn:aws:s3:::${bucket}/runner/*`,
    },
  )
  return JSON.stringify(policy)
}

/**
 * The AWS calls this makes, split by what a failure means.
 *
 * `--region` is passed to IAM as well as ECR/S3. IAM is global and ignores it;
 * one helper that always passes it is less surprising than one that does and
 * one that doesn't, drifting apart later.
 */
type Aws = {
  /** Whether a resource is already there. Absence is an answer, not a failure. */
  present: (args: string[]) => Promise<boolean>
  /** A question with an answer worth reading, parsed from the CLI's `--output json`. */
  read: (what: string, args: string[]) => Promise<any>
  /** A change. A non-zero exit fails the run, carrying the CLI's own message. */
  apply: (what: string, args: string[]) => Promise<void>
}

const awsFor = ({ run, region }: { run: Run; region: string }): Aws => {
  const call = (args: string[]): Promise<RunResult> => run('aws', [...args, '--region', region])
  return {
    async present(args) {
      return (await call(args)).code === 0
    },
    async read(what, args) {
      const result = await call([...args, '--output', 'json'])
      if (result.code !== 0) {
        throw new AwsBootstrapError(`${what}: ${result.stderr.trim() || `aws exited ${result.code}`}`)
      }
      try {
        return JSON.parse(result.stdout)
      } catch {
        throw new AwsBootstrapError(`${what}: aws returned invalid JSON (${result.stdout.slice(0, 200)})`)
      }
    },
    async apply(what, args) {
      const result = await call(args)
      if (result.code === 0) return
      throw new AwsBootstrapError(`${what}: ${result.stderr.trim() || `aws exited ${result.code}`}`)
    },
  }
}

/** Bootstrap versions the IAM permissions boundary that the Pulumi program attaches to every stage runtime role. */
const ensureRuntimeBoundary = async ({
  aws,
  scope,
  log,
}: {
  aws: Aws
  scope: DocumentScope
  log: (line: string) => void
}): Promise<string> => {
  const arn = `arn:aws:iam::${scope.accountId}:policy/${scope.native.app}-${scope.stage}-runtime-boundary`
  const document = documentFor('runtime-boundary-policy.json', scope)
  log(`==> ${arn}`)

  if (!(await aws.present(['iam', 'get-policy', '--policy-arn', arn]))) {
    await aws.apply('Could not create the runtime boundary', [
      'iam',
      'create-policy',
      '--policy-name',
      `${scope.native.app}-${scope.stage}-runtime-boundary`,
      '--description',
      'Maximum data-plane permissions for BoxLite workload roles',
      '--policy-document',
      document,
    ])
    log('    created')
    return arn
  }

  const { Versions } = await aws.read(`Could not list ${arn}'s versions`, [
    'iam',
    'list-policy-versions',
    '--policy-arn',
    arn,
  ])
  const disposable = Versions.filter((version: any) => !version.IsDefaultVersion).sort(
    (a: any, b: any) => new Date(a.CreateDate).getTime() - new Date(b.CreateDate).getTime(),
  )
  // About to add one more version; prune the oldest non-default ones until there is room for it.
  const overflow = Math.max(0, Versions.length - MANAGED_POLICY_VERSION_LIMIT + 1)
  for (const version of disposable.slice(0, overflow)) {
    await aws.apply(`Could not prune ${arn}'s version ${version.VersionId}`, [
      'iam',
      'delete-policy-version',
      '--policy-arn',
      arn,
      '--version-id',
      version.VersionId,
    ])
  }

  await aws.apply('Could not update the runtime boundary', [
    'iam',
    'create-policy-version',
    '--policy-arn',
    arn,
    '--policy-document',
    document,
    '--set-as-default',
  ])
  log('    updated')
  return arn
}

/**
 * The role GitHub Actions deploys as.
 *
 * Trust is per stage: every job that assumes this declares `environment:
 * <stage>` (mdeploy-all.yml), so GitHub's `sub` claim carries `environment:<stage>`
 * rather than the branch form — a role trusting only the branch form rejects
 * them all with `Not authorized to perform sts:AssumeRoleWithWebIdentity`,
 * which reads as a missing role rather than as the claim mismatch it is.
 *
 * Unlike backoffice/commerce's own deploy role, `<REPO>` renders from a value
 * resolved per invocation (bootstrap.ts's resolveRepo) rather than a name
 * fixed in a committed github.json: a community fork must be able to
 * bootstrap its own copy of this role, trusting its own repository, without
 * editing a file first.
 */
const ensureDeployRole = async ({
  aws,
  scope,
  log,
}: {
  aws: Aws
  scope: DocumentScope
  log: (line: string) => void
}): Promise<string> => {
  const name = nativeAwsNames({ app: scope.native.app, stage: scope.stage, accountId: scope.accountId }).roleName
  const trust = documentFor('deploy-role-trust.json', scope)
  log(`==> ${name}`)

  if (await aws.present(['iam', 'get-role', '--role-name', name])) {
    await aws.apply(`Could not update ${name}'s trust policy`, [
      'iam',
      'update-assume-role-policy',
      '--role-name',
      name,
      '--policy-document',
      trust,
    ])
    await aws.apply(`Could not set ${name}'s session duration`, [
      'iam',
      'update-role',
      '--role-name',
      name,
      '--max-session-duration',
      DEPLOY_SESSION_DURATION_SECONDS,
    ])
    log('    trust policy updated')
  } else {
    await aws.apply(`Could not create ${name}`, [
      'iam',
      'create-role',
      '--role-name',
      name,
      '--assume-role-policy-document',
      trust,
      '--max-session-duration',
      DEPLOY_SESSION_DURATION_SECONDS,
      '--description',
      'Short-lived role used only by the guarded BoxLite GitHub deployment environment',
    ])
    log('    created')
  }

  // Pulumi supplies the stage boundary on role creation. The deployment policy enforces that ARN.
  await aws.apply(`Could not write ${name}'s inline policy`, [
    'iam',
    'put-role-policy',
    '--role-name',
    name,
    '--policy-name',
    'boxlite-pulumi-deploy',
    '--policy-document',
    documentFor('deploy-role-policy.json', scope),
  ])
  log('    inline policy written')

  return `arn:aws:iam::${scope.accountId}:role/${name}`
}

/**
 * The Api's image repository, named through the same helper artifacts/api.ts
 * reads it back with (apiImageRepository) — one spelling, not two kept in
 * agreement by a test the way a CloudFormation resource name and a JS
 * constant needed to be.
 */
const ensureApiImageRepository = async ({
  aws,
  log,
  repository,
  settings,
}: {
  aws: Aws
  repository: string
  settings: NativeBootstrap
  log: (line: string) => void
}): Promise<string> => {
  log(`==> ${repository}`)

  if (await aws.present(['ecr', 'describe-repositories', '--repository-names', repository])) {
    await aws.apply('Could not reconcile repository tag mutability', [
      'ecr',
      'put-image-tag-mutability',
      '--repository-name',
      repository,
      '--image-tag-mutability',
      settings.immutableTags === false ? 'MUTABLE' : 'IMMUTABLE',
    ])
    await aws.apply('Could not reconcile repository scanning', [
      'ecr',
      'put-image-scanning-configuration',
      '--repository-name',
      repository,
      '--image-scanning-configuration',
      'scanOnPush=' + (settings.scanOnPush !== false),
    ])
    log('    already exists')
    return repository
  }
  // Immutable tags are what make a published commit mean exact bytes; scan on push is what
  // gives mbuild's severity gate something to read. Never deleted or replaced by this script —
  // a stronger guarantee than CloudFormation's DeletionPolicy: Retain gave the same resource.
  await aws.apply(`Could not create ${repository}`, [
    'ecr',
    'create-repository',
    '--repository-name',
    repository,
    '--image-tag-mutability',
    settings.immutableTags === false ? 'MUTABLE' : 'IMMUTABLE',
    '--image-scanning-configuration',
    'scanOnPush=' + (settings.scanOnPush !== false),
    '--encryption-configuration',
    'encryptionType=AES256',
  ])
  log('    created')
  return repository
}

/**
 * The Runner's build-mode install artifact bucket, named through the same
 * helper artifacts/runner.ts reads it back with (runnerArtifactsBucketName),
 * for the same one-spelling reason the Api repository above is.
 *
 * `create-bucket`'s location constraint is the one AWS CLI quirk this file
 * cannot fold into a plain `present`/`apply`: passing
 * `--create-bucket-configuration LocationConstraint=us-east-1` in that one
 * region is itself an error, because it is the CLI's implicit default.
 * CloudFormation's `AWS::S3::Bucket` absorbed that distinction silently; a
 * reconcile script has to name it.
 */
const ensureArtifactsBucket = async ({
  aws,
  stage,
  accountId,
  region,
  log,
  app,
}: {
  app: string
  aws: Aws
  stage: string
  accountId: string
  region: string
  log: (line: string) => void
}): Promise<string> => {
  const bucket = nativeAwsNames({ app, stage, accountId }).bucketName
  log(`==> ${bucket}`)

  if (await aws.present(['s3api', 'head-bucket', '--bucket', bucket])) {
    log('    already exists')
  } else {
    const locationConfiguration =
      region === 'us-east-1' ? [] : ['--create-bucket-configuration', `LocationConstraint=${region}`]
    await aws.apply(`Could not create ${bucket}`, [
      's3api',
      'create-bucket',
      '--bucket',
      bucket,
      ...locationConfiguration,
    ])
    log('    created')
  }

  await aws.apply(`Could not enable encryption on ${bucket}`, [
    's3api',
    'put-bucket-encryption',
    '--bucket',
    bucket,
    '--server-side-encryption-configuration',
    JSON.stringify({ Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] }),
  ])
  await aws.apply(`Could not enable versioning on ${bucket}`, [
    's3api',
    'put-bucket-versioning',
    '--bucket',
    bucket,
    '--versioning-configuration',
    'Status=Enabled',
  ])
  await aws.apply(`Could not block public access on ${bucket}`, [
    's3api',
    'put-public-access-block',
    '--bucket',
    bucket,
    '--public-access-block-configuration',
    'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true',
  ])
  // Superseded versions only, never current ones: buildRunnerUserData re-fetches the
  // commit-keyed tarball on every instance launch, so expiring a *current* object would make a
  // later replacement fail to boot — including for the stage that is currently deployed.
  await aws.apply(`Could not set the lifecycle rule on ${bucket}`, [
    's3api',
    'put-bucket-lifecycle-configuration',
    '--bucket',
    bucket,
    '--lifecycle-configuration',
    JSON.stringify({
      Rules: [
        {
          ID: 'expire-superseded-runner-builds',
          Filter: { Prefix: 'runner/' },
          Status: 'Enabled',
          NoncurrentVersionExpiration: { NoncurrentDays: 30 },
        },
      ],
    }),
  ])
  log('    encryption, versioning, public-access block and lifecycle rule set')
  return bucket
}

export type AwsBootstrapInput = {
  native: NativeBootstrap
  run: Run
  repo: string
  stage: string
  accountId: string
  region: string
  log: (line: string) => void
}

/** What was created, mirroring GcpBootstrapResult's shape in gcp.ts. */
export type AwsBootstrapResult = {
  roleArn: string
  boundaryArn: string
  repositoryName: string
  bucketName: string
}

/**
 * One invocation: everything an `mdeploy`/`mbuild` run on this stage needs on
 * AWS and cannot create for itself. Mirrors bootstrapGcp's shape in gcp.ts —
 * one exported entry point, reconciling rather than creating, called once
 * from bootstrap.ts's main().
 */
export const bootstrapAws = async ({
  run,
  repo,
  stage,
  accountId,
  region,
  log,
  native,
}: AwsBootstrapInput): Promise<AwsBootstrapResult> => {
  nativeAwsNames({ app: native.app, stage, accountId })
  if (
    !/^[a-z0-9][a-z0-9._/-]{1,255}$/.test(native.repository) ||
    !/^[a-z0-9][a-z0-9-]{1,45}$/.test(native.volumePrefix) ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(native.stateBucket)
  ) {
    throw new AwsBootstrapError('Invalid native AWS repository, volume prefix or state bucket')
  }
  const source = native.promotionSource
  if (source) {
    nativeAwsNames({ app: native.app, stage: source.stage, accountId })
    if (
      source.stage === stage ||
      !/^[a-z]{2}(-[a-z0-9]+)+-[0-9]+$/.test(source.region) ||
      !/^[a-z0-9][a-z0-9._/-]{1,255}$/.test(source.repository)
    )
      throw new AwsBootstrapError('Invalid AWS promotion source')
  }
  const aws = awsFor({ run, region })
  const scope: DocumentScope = { repo, stage, accountId, region, native }

  const boundaryArn = await ensureRuntimeBoundary({ aws, scope, log })
  const roleArn = await ensureDeployRole({ aws, scope, log })
  const repositoryName = await ensureApiImageRepository({
    aws,
    log,
    repository: native.repository,
    settings: native,
  })
  const bucketName = await ensureArtifactsBucket({ aws, stage, accountId, region, log, app: native.app })

  return { roleArn, boundaryArn, repositoryName, bucketName }
}
