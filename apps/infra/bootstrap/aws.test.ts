// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { AwsBootstrapError, bootstrapAws, render, type Run } from './aws.js'

/** The calls this file treats as questions rather than changes. */
const PRESENCE_QUERIES = ['iam get-policy', 'iam get-role', 'ecr describe-repositories', 's3api head-bucket']

/**
 * A `run` that records what it was asked to do. `existing` decides how the
 * existence questions are answered; `versions` seeds what `list-policy-versions`
 * reports. Every change succeeds, which is what makes a failing change its own
 * test below.
 */
const recorder = ({ existing = false, versions = [] as any[] } = {}) => {
  const calls: string[][] = []
  const run: Run = async (command, args) => {
    calls.push([command, ...args])
    const asked = args.join(' ')
    if (asked.startsWith('iam list-policy-versions')) {
      return { code: 0, stdout: JSON.stringify({ Versions: versions }), stderr: '' }
    }
    if (PRESENCE_QUERIES.some((query) => asked.startsWith(query))) {
      return existing ? { code: 0, stdout: '{}', stderr: '' } : { code: 254, stdout: '', stderr: 'not found' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  const applied = (...needles: string[]): string[][] =>
    calls.filter((call) => needles.every((needle) => call.join(' ').includes(needle)))
  return { run, calls, applied }
}

const SCOPE = {
  native: {
    app: 'boxlite-app',
    stateBucket: 'fixture-state',
    volumePrefix: 'boxlite-volume',
    repository: 'boxlite-app-dev-api',
  },
  repo: 'boxlite-ai/boxlite',
  stage: 'dev',
  accountId: '123456789012',
  region: 'ap-southeast-1',
}

/** One invocation, with the coordinates a real run would read from bootstrap.ts's main(). */
const invoke = (run: Run) => bootstrapAws({ run, ...SCOPE, log: () => {} })

test('a fresh stage gets every prerequisite mdeploy and mbuild cannot create for themselves', async () => {
  const aws = recorder()
  const result = await invoke(aws.run)

  assert.equal(aws.applied('iam create-policy').length, 1, 'no runtime boundary')
  assert.equal(aws.applied('iam create-role').length, 1, 'no deploy role')
  assert.equal(aws.applied('iam put-role-policy').length, 1, 'no inline policy')
  assert.equal(aws.applied('ecr create-repository').length, 1, 'no Api repository')
  assert.equal(aws.applied('s3api create-bucket').length, 1, 'no artifacts bucket')
  assert.equal(aws.applied('s3api put-bucket-encryption').length, 1)
  assert.equal(aws.applied('s3api put-bucket-versioning').length, 1)
  assert.equal(aws.applied('s3api put-public-access-block').length, 1)
  assert.equal(aws.applied('s3api put-bucket-lifecycle-configuration').length, 1)

  assert.equal(result.roleArn, 'arn:aws:iam::123456789012:role/boxlite-app-dev-pulumi-deploy')
  assert.equal(result.boundaryArn, 'arn:aws:iam::123456789012:policy/boxlite-app-dev-runtime-boundary')
  assert.equal(result.repositoryName, 'boxlite-app-dev-api')
  const repositoryCall = aws.applied('ecr create-repository')[0]
  assert.equal(repositoryCall[repositoryCall.indexOf('--image-tag-mutability') + 1], 'IMMUTABLE')
  assert.equal(repositoryCall[repositoryCall.indexOf('--image-scanning-configuration') + 1], 'scanOnPush=true')
  assert.equal(result.bucketName, 'boxlite-app-dev-artifacts-123456789012')

  // The rendered trust document carries no placeholder left to substitute.
  const createRoleCall = aws.applied('iam create-role')[0]
  const trustArgIndex = createRoleCall.indexOf('--assume-role-policy-document') + 1
  assert.doesNotMatch(createRoleCall[trustArgIndex], /<[A-Z]+>/)
})

test('re-running reconciles what is there instead of creating it again', async () => {
  const aws = recorder({
    existing: true,
    versions: [{ VersionId: 'v1', IsDefaultVersion: true, CreateDate: '2026-01-01T00:00:00Z' }],
  })
  await invoke(aws.run)

  for (const created of ['iam create-policy ', 'iam create-role', 'ecr create-repository', 's3api create-bucket']) {
    assert.deepEqual(aws.applied(created), [], `${created} ran against a stage that already has it`)
  }

  assert.equal(aws.applied('iam create-policy-version').length, 1)
  assert.equal(aws.applied('iam update-assume-role-policy').length, 1)
  assert.equal(aws.applied('iam update-role', '--max-session-duration').length, 1)
  // Reapplied every run regardless of presence, matching the CFN template's idempotent desired state.
  assert.equal(aws.applied('iam put-role-policy').length, 1)
  assert.equal(aws.applied('s3api put-bucket-encryption').length, 1)
})

test('a runtime boundary at the version cap is pruned before a new version is created', async () => {
  const versions = Array.from({ length: 5 }, (_, index) => ({
    VersionId: `v${index + 1}`,
    IsDefaultVersion: index === 4,
    CreateDate: `2026-01-0${index + 1}T00:00:00Z`,
  }))
  const aws = recorder({ existing: true, versions })
  await invoke(aws.run)

  const pruned = aws.applied('iam delete-policy-version')
  assert.equal(pruned.length, 1, 'exactly one old version must be pruned to make room for the new one')
  assert.ok(pruned[0].includes('v1'), 'the oldest non-default version is the one pruned, not an arbitrary one')
  assert.equal(aws.applied('iam create-policy-version').length, 1)
})

test('a runtime boundary well under the version cap is never pruned', async () => {
  const versions = [
    { VersionId: 'v1', IsDefaultVersion: false, CreateDate: '2026-01-01T00:00:00Z' },
    { VersionId: 'v2', IsDefaultVersion: true, CreateDate: '2026-01-02T00:00:00Z' },
  ]
  const aws = recorder({ existing: true, versions })
  await invoke(aws.run)

  assert.deepEqual(aws.applied('iam delete-policy-version'), [])
})

test('render fills in every placeholder and leaves the rest untouched', () => {
  const rendered = render('<REPO> <STAGE> <ACCOUNT> <REGION> unchanged', SCOPE)
  assert.equal(rendered, 'boxlite-ai/boxlite dev 123456789012 ap-southeast-1 unchanged')
})

test('create-bucket omits the location constraint only in us-east-1', async () => {
  const usEast1 = recorder()
  await bootstrapAws({ run: usEast1.run, ...SCOPE, region: 'us-east-1', log: () => {} })
  const [createBucket] = usEast1.applied('s3api create-bucket')
  assert.ok(createBucket, 'no create-bucket call recorded')
  assert.doesNotMatch(createBucket.join(' '), /create-bucket-configuration/)

  const otherRegion = recorder()
  await invoke(otherRegion.run)
  const [createBucketOther] = otherRegion.applied('s3api create-bucket')
  assert.match(createBucketOther.join(' '), /LocationConstraint=ap-southeast-1/)
})

test('a failing AWS call surfaces the CLI stderr rather than a generic failure', async () => {
  const run: Run = async (_command, args) => {
    if (args.join(' ').startsWith('iam get-policy')) return { code: 254, stdout: '', stderr: 'not found' }
    if (args.join(' ').startsWith('iam create-policy')) return { code: 1, stdout: '', stderr: 'AccessDenied: nope' }
    return { code: 0, stdout: '', stderr: '' }
  }
  await assert.rejects(
    invoke(run),
    (error: any) => error instanceof AwsBootstrapError && /AccessDenied: nope/.test(error.message),
  )
})

test('native AWS bootstrap follows declared identities and protects privileged IAM roles', async () => {
  const aws = recorder()
  const result = await bootstrapAws({
    run: aws.run,
    ...SCOPE,
    log: () => {},
    native: {
      app: 'community-app',
      repository: 'community-images',
      stateBucket: 'existing-state-bucket',
      volumePrefix: 'community-dev-volume',
    },
  })
  assert.equal(result.roleArn, 'arn:aws:iam::123456789012:role/community-app-dev-pulumi-deploy')
  assert.equal(result.boundaryArn, 'arn:aws:iam::123456789012:policy/community-app-dev-runtime-boundary')
  assert.equal(result.repositoryName, 'community-images')
  assert.equal(result.bucketName, 'community-app-dev-artifacts-123456789012')
  const policyCall = aws.applied('iam put-role-policy')[0]
  const policy = JSON.parse(policyCall[policyCall.indexOf('--policy-document') + 1])
  assert.ok(JSON.stringify(policy).length < 10_240, 'inline role policy exceeds the IAM aggregate size limit')
  assert.doesNotMatch(JSON.stringify(policy), /<[A-Z_]+>/)
  const rollout = policy.Statement.find((s: any) => s.Sid === 'RunnerRollout')
  assert.deepEqual(rollout.Action, ['s3:GetObject', 's3:PutObject'])
  assert.deepEqual(rollout.Resource, [
    'arn:aws:s3:::existing-state-bucket/rollouts/aws/community-app/dev/ap-southeast-1/i-*.json',
  ])
  for (const action of ['route53:CreateHostedZone', 'route53:GetHostedZone', 'route53:ListHostedZonesByName']) {
    assert.ok(
      policy.Statement.some((s: any) => s.Effect === 'Allow' && s.Action.includes(action)),
      action,
    )
  }
  const deny = policy.Statement.find((statement: any) => statement.Sid === 'DenySelfPrivilegeEscalation')
  assert.ok(deny.Action.includes('iam:DeleteRolePolicy'))
  assert.ok(deny.Resource.includes('arn:aws:iam::123456789012:role/boxlite-*-github-deploy'))
  assert.ok(deny.Resource.includes('arn:aws:iam::123456789012:role/community-app-*-pulumi-deploy'))
  assert.equal(
    aws.applied('--role-name boxlite-dev-github-deploy').length,
    0,
    'native bootstrap changed the legacy role',
  )
  const boundaryCall = aws.applied('iam create-policy')[0]
  const boundary = JSON.parse(boundaryCall[boundaryCall.indexOf('--policy-document') + 1])
  const growth = boundary.Statement.find((statement: any) => statement.Sid === 'RunnerDataDiskGrowth')
  assert.deepEqual(growth.Condition.StringEquals, {
    'ec2:ResourceTag/boxlite:app': 'community-app',
    'ec2:ResourceTag/boxlite:stage': 'dev',
    'ec2:ResourceTag/boxlite:role': 'runner-data',
  })
  const repoArn = 'arn:aws:ecr:ap-southeast-1:123456789012:repository/community-images'
  for (const [doc, required] of [
    [policy, ['ecr:PutImage', 'ecr:DescribeRepositories']],
    [boundary, ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer']],
  ] as const) {
    for (const action of required) {
      const grants = doc.Statement.filter(
        (s: any) =>
          s.Effect === 'Allow' && [s.Action].flat().some((a: string) => a === action || a === 'ecr:*' || a === '*'),
      )
      assert.deepEqual(
        grants.flatMap((s: any) => [s.Resource].flat()),
        [repoArn],
        action,
      )
    }
    assert.ok(
      doc.Statement.some((s: any) => [s.Action].flat().includes('ecr:GetAuthorizationToken') && s.Resource === '*'),
    )
  }
  const registry = boundary.Statement.find((statement: any) => statement.Sid === 'RegistryCredentialAccessCeiling')
  assert.equal(
    registry.Resource,
    'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:registry-credential-community-app_dev_-*',
  )
})

test('native bootstrap validates names before cloud calls and honors declared ECR settings', async () => {
  const native = {
    app: 'community-app',
    repository: 'community-images',
    stateBucket: 'existing-state-bucket',
    volumePrefix: 'community-dev-volume',
    immutableTags: false,
    scanOnPush: false,
  }
  for (const invalid of [
    { ...native, app: '../invalid' },
    { ...native, volumePrefix: 'unsafe/*' },
  ]) {
    const aws = recorder()
    await assert.rejects(
      bootstrapAws({ run: aws.run, ...SCOPE, native: invalid, log: () => {} }),
      /valid native AWS|Invalid native AWS/,
    )
    assert.equal(aws.calls.length, 0)
  }
  const aws = recorder()
  await bootstrapAws({ run: aws.run, ...SCOPE, native, log: () => {} })
  const repository = aws.applied('ecr create-repository')[0]
  assert.equal(repository[repository.indexOf('--image-tag-mutability') + 1], 'MUTABLE')
  assert.equal(repository[repository.indexOf('--image-scanning-configuration') + 1], 'scanOnPush=false')
})

test('the destination deployer can read only the declared promotion artifacts at the source', async () => {
  const aws = recorder()
  const native = {
    app: 'community',
    repository: 'target-images',
    stateBucket: 'fixture-state',
    volumePrefix: 'community-dev',
    promotionSource: { stage: 'dev-blue', region: 'eu-west-1', repository: 'source-images' },
  }
  await bootstrapAws({ ...SCOPE, run: aws.run, native, log: () => {} })
  const call = aws.applied('iam put-role-policy')[0]
  const policy = JSON.parse(call[call.indexOf('--policy-document') + 1])
  const grants = (resource: string) =>
    policy.Statement.filter((s: any) => s.Effect === 'Allow' && [s.Resource].flat().includes(resource))
      .flatMap((s: any) => [s.Action].flat())
      .sort()
  assert.deepEqual(grants('arn:aws:ecr:eu-west-1:123456789012:repository/source-images'), [
    'ecr:BatchCheckLayerAvailability',
    'ecr:BatchGetImage',
    'ecr:DescribeImages',
    'ecr:GetDownloadUrlForLayer',
  ])
  const source = 'arn:aws:s3:::community-dev-blue-artifacts-123456789012'
  assert.deepEqual(grants(source), ['s3:ListBucket'])
  assert.deepEqual(grants(source + '/runner/*'), ['s3:GetObject'])
  assert.deepEqual(grants(source + '/*'), [])
  const allowsObjectAction = (action: string, resource: string) =>
    policy.Statement.filter(
      (s: any) => s.Effect === 'Allow' && [s.Action].flat().some((a) => a === action || a === 's3:*' || a === '*'),
    ).some((s: any) =>
      [s.Resource].flat().some((pattern: string) => {
        const parts = pattern.split('*').map((literal) => literal.replace(/[.+?^$(){}|[\]\\]/g, '\\$&'))
        return new RegExp('^' + parts.join('.*') + '$').test(resource)
      }),
    )
  const artifact = '/runner/revision/archive.tar.gz'
  for (const action of ['s3:PutObject', 's3:DeleteObject', 's3:PutObjectTagging']) {
    assert.equal(allowsObjectAction(action, source + artifact), false, action + ' on promotion source')
    assert.equal(allowsObjectAction(action, 'arn:aws:s3:::community-dev-artifacts-123456789012' + artifact), true)
  }
  assert.equal(allowsObjectAction('s3:GetObject', source + artifact), true)
  assert.equal(allowsObjectAction('s3:GetObject', source + '/private/key'), false)
  assert.ok(JSON.stringify(policy).length < 10_240)
})

test('fresh ECS scaling can create its service-linked role', async () => {
  const aws = recorder()
  await invoke(aws.run)
  const call = aws.applied('iam put-role-policy')[0]
  const policy = JSON.parse(call[call.indexOf('--policy-document') + 1])
  const principals = policy.Statement.filter(
    (s: any) => s.Effect === 'Allow' && s.Action === 'iam:CreateServiceLinkedRole',
  ).flatMap((s: any) => s.Condition.StringEquals['iam:AWSServiceName'])
  assert.ok(
    principals.includes('ecs.application-autoscaling.amazonaws.com'),
    'missing ECS Application Auto Scaling service principal',
  )
  assert.ok(!principals.includes('*'))
})

test('the runtime boundary limits Parameter Store reads to the workload namespace', async () => {
  const aws = recorder()
  await invoke(aws.run)
  const call = aws.applied('iam create-policy')[0]
  const boundary = JSON.parse(call[call.indexOf('--policy-document') + 1])
  for (const action of ['ssm:GetParameter', 'ssm:GetParameters']) {
    const resources = boundary.Statement.filter(
      (s: any) => s.Effect === 'Allow' && [s.Action].flat().includes(action),
    ).flatMap((s: any) => s.Resource)
    assert.deepEqual(resources, [
      'arn:aws:ssm:ap-southeast-1:123456789012:parameter/boxlite/workloads/boxlite-app/dev/*',
    ])
  }
})

test('stage credentials cannot match credentials belonging to a hyphenated sibling', async () => {
  const aws = recorder()
  await invoke(aws.run)
  const boundaryCall = aws.applied('iam create-policy')[0]
  const boundary = JSON.parse(boundaryCall[boundaryCall.indexOf('--policy-document') + 1])
  const deployCall = aws.applied('iam put-role-policy')[0]
  const policy = JSON.parse(deployCall[deployCall.indexOf('--policy-document') + 1])
  const scope = 'arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:'
  for (const [document, action] of [
    [boundary, 'secretsmanager:GetSecretValue'],
    [policy, 'secretsmanager:*'],
  ] as const) {
    const prefixes = document.Statement.filter((s: any) => s.Effect === 'Allow' && [s.Action].flat().includes(action))
      .flatMap((s: any) => s.Resource)
      .map((arn: string) => arn.replace(/\*$/, ''))
    const grants = (name: string) => prefixes.some((prefix: string) => (scope + name).startsWith(prefix))
    for (const name of [
      'boxlite-app-dev-blue-gate-Abc123',
      'boxlite-dev-blue-gate-Abc123',
      'registry-credential-boxlite-app-dev-blue-key-Abc123',
      'boxlite/workloads/boxlite-app/dev-blue/gate-Abc123',
      'registry-credential-boxlite-app_dev-blue_-id-Abc123',
    ])
      assert.equal(grants(name), false, name)
    assert.equal(grants('boxlite/workloads/boxlite-app/dev/gate-Abc123'), true)
    assert.equal(grants('registry-credential-boxlite-app_dev_-id-Abc123'), true)
  }
})
