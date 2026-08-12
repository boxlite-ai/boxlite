// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertDeployPolicyContract,
  assertDeployRoleStackComplete,
  assertDeployRoleTopology,
  assertSelectedStageRolesBounded,
  parseAssumedRoleName,
  policyDocumentsAllow,
  verifyDeployRoleGrantsBoundaryPermission,
} from './deploy-role-boundary.mjs'

const ACCOUNT_ID = '123456789012'
const CALLER_ARN = `arn:aws:sts::${ACCOUNT_ID}:assumed-role/boxlite-app-dev-deploy/deploy-dev-stack-30606029374`

// Mirrors ci/github-deploy-role.yaml's selected-stage role resources and
// SetBoxLiteRoleBoundary condition, so a change to the real template that
// this check can no longer see is caught by editing this fixture, not by a
// live AWS surprise.
function boundedRoleStatements(boundaryArn) {
  return [
    {
      Sid: 'ReadIamAndAccountMetadata',
      Effect: 'Allow',
      Action: ['iam:GetRole', 'iam:ListRolePolicies', 'sts:GetCallerIdentity'],
      Resource: '*',
    },
    {
      Sid: 'ManageBoxLiteRoles',
      Effect: 'Allow',
      Action: ['iam:AttachRolePolicy', 'iam:UpdateRole'],
      Resource: [`arn:aws:iam::${ACCOUNT_ID}:role/boxlite-dev-*`],
    },
    {
      Sid: 'SetBoxLiteRoleBoundary',
      Effect: 'Allow',
      Action: 'iam:PutRolePermissionsBoundary',
      Resource: `arn:aws:iam::${ACCOUNT_ID}:role/boxlite-dev-*`,
      Condition: { StringEquals: { 'iam:PermissionsBoundary': boundaryArn } },
    },
  ]
}

test('parseAssumedRoleName extracts the role name from an assumed-role ARN', () => {
  assert.equal(parseAssumedRoleName(CALLER_ARN), 'boxlite-app-dev-deploy')
})

test('parseAssumedRoleName rejects a non-assumed-role ARN', () => {
  assert.throws(
    () => parseAssumedRoleName(`arn:aws:iam::${ACCOUNT_ID}:role/boxlite-app-dev-deploy`),
    /is not an assumed-role ARN/,
  )
})

// Every boundary ARN this stack can compare against is a literal `arn:aws:`
// (sst.config.ts:166). An identity from another partition must be rejected by
// name here rather than reappearing downstream as a boundary mismatch.
test('parseAssumedRoleName rejects a non-commercial partition', () => {
  for (const partition of ['aws-us-gov', 'aws-cn']) {
    assert.throws(
      () => parseAssumedRoleName(`arn:${partition}:sts::${ACCOUNT_ID}:assumed-role/boxlite-app-dev-deploy/session`),
      /partition 'aws-(us-gov|cn)' is not supported/,
    )
  }
})

test('the deploy-role verifier accepts only a completed exact stage stack', () => {
  assert.deepEqual(
    assertDeployRoleStackComplete({
      stage: 'dev',
      stacks: [{ StackName: 'boxlite-dev-github-deploy', StackStatus: 'UPDATE_COMPLETE' }],
    }),
    { stackName: 'boxlite-dev-github-deploy', stackStatus: 'UPDATE_COMPLETE' },
  )
  for (const stacks of [
    [],
    [{ StackName: 'boxlite-prod-github-deploy', StackStatus: 'UPDATE_COMPLETE' }],
    [{ StackName: 'boxlite-dev-github-deploy', StackStatus: 'UPDATE_IN_PROGRESS' }],
    [{ StackName: 'boxlite-dev-github-deploy', StackStatus: 'UPDATE_ROLLBACK_COMPLETE' }],
  ]) {
    assert.throws(() => assertDeployRoleStackComplete({ stage: 'dev', stacks }), /CloudFormation stack|complete/i)
  }
})

test('the deploy-role policy contract refuses an incomplete policy document', () => {
  assert.throws(
    () =>
      assertDeployPolicyContract({
        policyDocument: { Version: '2012-10-17', Statement: [] },
        accountId: ACCOUNT_ID,
        partition: 'aws',
        region: 'ap-southeast-1',
        stage: 'dev',
      }),
    /deploy policy contract/i,
  )
})

test('policyDocumentsAllow matches the real SetBoxLiteRoleBoundary statement', () => {
  const boundaryArn = `arn:aws:iam::${ACCOUNT_ID}:policy/boxlite-dev-runtime-boundary`
  const allowed = policyDocumentsAllow([{ Statement: boundedRoleStatements(boundaryArn) }], {
    action: 'iam:PutRolePermissionsBoundary',
    resource: `arn:aws:iam::${ACCOUNT_ID}:role/boxlite-dev-verify-probe`,
    conditionKey: 'iam:PermissionsBoundary',
    conditionValue: boundaryArn,
  })
  assert.equal(allowed, true)
})

test('policyDocumentsAllow rejects when the condition value is for a different stage', () => {
  const devBoundaryArn = `arn:aws:iam::${ACCOUNT_ID}:policy/boxlite-dev-runtime-boundary`
  const productionBoundaryArn = `arn:aws:iam::${ACCOUNT_ID}:policy/boxlite-production-runtime-boundary`
  const allowed = policyDocumentsAllow([{ Statement: boundedRoleStatements(devBoundaryArn) }], {
    action: 'iam:PutRolePermissionsBoundary',
    resource: `arn:aws:iam::${ACCOUNT_ID}:role/boxlite-production-verify-probe`,
    conditionKey: 'iam:PermissionsBoundary',
    conditionValue: productionBoundaryArn,
  })
  assert.equal(allowed, false)
})

test('policyDocumentsAllow reproduces today\'s incident: policy has no boundary-set statement at all', () => {
  const boundaryArn = `arn:aws:iam::${ACCOUNT_ID}:policy/boxlite-dev-runtime-boundary`
  const [readOnly, manageRoles] = boundedRoleStatements(boundaryArn) // drop SetBoxLiteRoleBoundary
  const allowed = policyDocumentsAllow([{ Statement: [readOnly, manageRoles] }], {
    action: 'iam:PutRolePermissionsBoundary',
    resource: `arn:aws:iam::${ACCOUNT_ID}:role/boxlite-dev-verify-probe`,
    conditionKey: 'iam:PermissionsBoundary',
    conditionValue: boundaryArn,
  })
  assert.equal(allowed, false)
})

test('policyDocumentsAllow treats an unconditional allow as sufficient', () => {
  const allowed = policyDocumentsAllow(
    [
      {
        Statement: [
          { Effect: 'Allow', Action: 'iam:PutRolePermissionsBoundary', Resource: `arn:aws:iam::${ACCOUNT_ID}:role/boxlite-*` },
        ],
      },
    ],
    {
      action: 'iam:PutRolePermissionsBoundary',
      resource: `arn:aws:iam::${ACCOUNT_ID}:role/boxlite-dev-verify-probe`,
      conditionKey: 'iam:PermissionsBoundary',
      conditionValue: `arn:aws:iam::${ACCOUNT_ID}:policy/boxlite-dev-runtime-boundary`,
    },
  )
  assert.equal(allowed, true)
})

test('policyDocumentsAllow ignores a Deny statement instead of treating it as a grant', () => {
  const boundaryArn = `arn:aws:iam::${ACCOUNT_ID}:policy/boxlite-dev-runtime-boundary`
  const allowed = policyDocumentsAllow(
    [
      {
        Statement: {
          Effect: 'Deny',
          Action: 'iam:PutRolePermissionsBoundary',
          Resource: `arn:aws:iam::${ACCOUNT_ID}:role/boxlite-*`,
        },
      },
    ],
    {
      action: 'iam:PutRolePermissionsBoundary',
      resource: `arn:aws:iam::${ACCOUNT_ID}:role/boxlite-dev-verify-probe`,
      conditionKey: 'iam:PermissionsBoundary',
      conditionValue: boundaryArn,
    },
  )
  assert.equal(allowed, false)
})

test('the deploy-role verifier rejects managed-policy grants instead of composing mutable topology', () => {
  const boundaryArn = `arn:aws:iam::${ACCOUNT_ID}:policy/boxlite-dev-runtime-boundary`
  const inlineOnlyReadAccess = { Statement: [{ Effect: 'Allow', Action: 'iam:GetRole', Resource: '*' }] }
  const managedGrantsBoundary = { Statement: boundedRoleStatements(boundaryArn) }
  assert.equal(
    policyDocumentsAllow([inlineOnlyReadAccess, managedGrantsBoundary], {
      action: 'iam:PutRolePermissionsBoundary',
      resource: `arn:aws:iam::${ACCOUNT_ID}:role/boxlite-dev-verify-probe`,
      conditionKey: 'iam:PermissionsBoundary',
      conditionValue: boundaryArn,
    }),
    true,
    'the low-level matcher still demonstrates why topology must be checked separately',
  )
  assert.throws(
    () =>
      assertDeployRoleTopology({
        roleName: 'boxlite-dev-github-deploy',
        stage: 'dev',
        inlinePolicyNames: ['boxlite-sst-deploy'],
        attachedPolicyArns: ['arn:aws:iam::aws:policy/AdministratorAccess'],
        roleTags: [{ Key: 'boxlite:deploy-policy-contract', Value: 'v1' }],
      }),
    /must not have attached managed policies/i,
  )
})

test('the deploy-role verifier requires one exact inline-only policy topology', () => {
  const valid = {
    roleName: 'boxlite-dev-github-deploy',
    stage: 'dev',
    inlinePolicyNames: ['boxlite-sst-deploy'],
    attachedPolicyArns: [],
    roleTags: [{ Key: 'boxlite:deploy-policy-contract', Value: 'v1' }],
  }
  assert.deepEqual(assertDeployRoleTopology(valid), {
    roleName: valid.roleName,
    policyName: 'boxlite-sst-deploy',
  })

  for (const invalid of [
    { ...valid, roleName: 'boxlite-dev-deploy' },
    { ...valid, inlinePolicyNames: [] },
    { ...valid, inlinePolicyNames: ['boxlite-sst-deploy', 'extra'] },
    { ...valid, inlinePolicyNames: ['renamed'] },
    { ...valid, attachedPolicyArns: ['arn:aws:iam::123456789012:policy/extra'] },
    { ...valid, roleTags: [] },
    { ...valid, roleTags: [{ Key: 'boxlite:deploy-policy-contract', Value: 'v0' }] },
    { ...valid, roleTags: [{ Key: 'BoxLite:Deploy-Policy-Contract', Value: 'v1' }] },
  ]) {
    assert.throws(() => assertDeployRoleTopology(invalid), /deploy role|inline policy|managed policies/i)
  }
})

test('the deploy-role verifier rejects any existing unbounded selected-stage role', () => {
  const boundaryArn = `arn:aws:iam::${ACCOUNT_ID}:policy/boxlite-dev-runtime-boundary`
  const deployRole = { RoleName: 'boxlite-dev-github-deploy' }
  const bounded = {
    RoleName: 'boxlite-dev-RunnerRole-a1b2c3',
    PermissionsBoundary: { PermissionsBoundaryArn: boundaryArn, PermissionsBoundaryType: 'Policy' },
  }
  const unrelated = { RoleName: 'boxlite-prod-RunnerRole-a1b2c3' }

  assert.deepEqual(
    assertSelectedStageRolesBounded({ roles: [deployRole, bounded, unrelated], accountId: ACCOUNT_ID, stage: 'dev' }),
    { boundaryArn, roleCount: 2 },
  )
  assert.throws(
    () =>
      assertSelectedStageRolesBounded({
        roles: [deployRole, { RoleName: 'boxlite-dev-stale-unbounded' }],
        accountId: ACCOUNT_ID,
        stage: 'dev',
      }),
    /does not carry the required runtime boundary/i,
  )
  assert.throws(
    () => assertSelectedStageRolesBounded({ roles: [bounded], accountId: ACCOUNT_ID, stage: 'dev' }),
    /does not contain.*github-deploy/i,
  )
  assert.throws(
    () => assertSelectedStageRolesBounded({ roles: [deployRole, deployRole], accountId: ACCOUNT_ID, stage: 'dev' }),
    /duplicate role/i,
  )
})

test('verifyDeployRoleGrantsBoundaryPermission ties the caller ARN, account, and stage together', () => {
  const boundaryArn = `arn:aws:iam::${ACCOUNT_ID}:policy/boxlite-dev-runtime-boundary`
  const result = verifyDeployRoleGrantsBoundaryPermission({
    callerArn: CALLER_ARN,
    accountId: ACCOUNT_ID,
    stage: 'dev',
    policyDocuments: [{ Statement: boundedRoleStatements(boundaryArn) }],
  })
  assert.deepEqual(result, { roleName: 'boxlite-app-dev-deploy', boundaryArn, grants: true })
})

test('verifyDeployRoleGrantsBoundaryPermission reports false for the actual failed run (2026-07-31)', () => {
  // The exact shape of https://github.com/boxlite-ai/boxlite/actions/runs/30606029374/job/91078321370:
  // boxlite-app-dev-deploy has no statement granting iam:PutRolePermissionsBoundary at all.
  const result = verifyDeployRoleGrantsBoundaryPermission({
    callerArn: CALLER_ARN,
    accountId: ACCOUNT_ID,
    stage: 'dev',
    policyDocuments: [
      { Statement: [{ Effect: 'Allow', Action: 'iam:GetRole', Resource: '*' }] },
    ],
  })
  assert.equal(result.grants, false)
})
