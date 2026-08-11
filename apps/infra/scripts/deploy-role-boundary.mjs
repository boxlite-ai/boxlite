// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Pure checks for `verify-deploy-role-boundary.mjs`. The CI preflight binds
 * the live role to one completed CloudFormation stack, one inline-only
 * topology, and the exact reviewed SSM, Secrets Manager, IAM, and Runner-gate
 * statements before selected code receives AWS access. The small generic
 * matcher below remains only for the positive permissions-boundary probe; it
 * is not an AWS policy simulator.
 */

import { githubDeployRoleStackName, runtimeBoundaryPolicyArn } from './environment-bootstrap.mjs'

const ASSUMED_ROLE_ARN_PATTERN = /^arn:(aws(?:-us-gov|-cn)?):sts::(\d{12}):assumed-role\/([^/]+)\/[^/]+$/
export const DEPLOY_POLICY_CONTRACT_TAG = 'boxlite:deploy-policy-contract'
export const DEPLOY_POLICY_CONTRACT_VERSION = 'v1'

export function parseAssumedRoleIdentity(arn) {
  const match = typeof arn === 'string' ? arn.match(ASSUMED_ROLE_ARN_PATTERN) : null
  if (!match) {
    throw new Error(`'${arn}' is not an assumed-role ARN (expected arn:<partition>:sts::<account>:assumed-role/<role>/<session>)`)
  }
  return { partition: match[1], accountId: match[2], roleName: match[3] }
}

export const parseAssumedRoleName = (arn) => parseAssumedRoleIdentity(arn).roleName

function asArray(value) {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

export function assertDeployRoleTopology({
  roleName,
  stage,
  inlinePolicyNames,
  attachedPolicyArns,
  roleTags,
}) {
  const expectedRoleName = `boxlite-${stage}-github-deploy`
  if (roleName !== expectedRoleName) {
    throw new Error(`deploy role must be exactly '${expectedRoleName}'`)
  }
  if (
    !Array.isArray(inlinePolicyNames) ||
    inlinePolicyNames.length !== 1 ||
    inlinePolicyNames[0] !== 'boxlite-sst-deploy'
  ) {
    throw new Error("deploy role must have exactly one inline policy named 'boxlite-sst-deploy'")
  }
  if (!Array.isArray(attachedPolicyArns) || attachedPolicyArns.length !== 0) {
    throw new Error('deploy role must not have attached managed policies')
  }
  if (!Array.isArray(roleTags)) throw new Error('deploy role policy contract tag is missing')
  const contractTags = roleTags.filter(
    (tag) => typeof tag?.Key === 'string' && tag.Key.toLowerCase() === DEPLOY_POLICY_CONTRACT_TAG,
  )
  if (
    contractTags.length !== 1 ||
    contractTags[0].Key !== DEPLOY_POLICY_CONTRACT_TAG ||
    contractTags[0].Value !== DEPLOY_POLICY_CONTRACT_VERSION
  ) {
    throw new Error(`deploy role policy contract tag must be exactly ${DEPLOY_POLICY_CONTRACT_VERSION}`)
  }
  return { roleName, policyName: inlinePolicyNames[0] }
}

export function assertDeployRoleStackComplete({ stage, stacks }) {
  const stackName = githubDeployRoleStackName(stage)
  if (!Array.isArray(stacks) || stacks.length !== 1 || stacks[0]?.StackName !== stackName) {
    throw new Error(`CloudFormation stack '${stackName}' must exist exactly once`)
  }
  const stackStatus = stacks[0].StackStatus
  if (stackStatus !== 'CREATE_COMPLETE' && stackStatus !== 'UPDATE_COMPLETE') {
    throw new Error(`CloudFormation stack '${stackName}' must be complete before the deploy role is used`)
  }
  return { stackName, stackStatus }
}

function canonicalPolicyValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalPolicyValue).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalPolicyValue(nested)]),
    )
  }
  return value
}

function assertExactPolicyStatement(statements, expected) {
  const actual = statements.get(expected.Sid)
  if (!actual) throw new Error(`deploy policy contract is missing ${expected.Sid}`)
  if (JSON.stringify(canonicalPolicyValue(actual)) !== JSON.stringify(canonicalPolicyValue(expected))) {
    throw new Error(`deploy policy contract statement ${expected.Sid} does not match the reviewed policy`)
  }
}

export function assertDeployPolicyContract({ policyDocument, accountId, partition, region, stage }) {
  if (!/^\d{12}$/.test(accountId ?? '')) throw new Error('deploy policy contract requires a 12-digit account id')
  if (!/^aws(?:-us-gov|-cn)?$/.test(partition ?? '')) throw new Error('deploy policy contract requires an AWS partition')
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region ?? '')) {
    throw new Error('deploy policy contract requires an AWS region')
  }
  githubDeployRoleStackName(stage)
  if (policyDocument?.Version !== '2012-10-17' || !Array.isArray(policyDocument.Statement)) {
    throw new Error('deploy policy contract must be an IAM policy document')
  }

  const statements = new Map()
  for (const statement of policyDocument.Statement) {
    if (typeof statement?.Sid !== 'string' || statements.has(statement.Sid)) {
      throw new Error('deploy policy contract contains an invalid or duplicate statement id')
    }
    statements.set(statement.Sid, statement)
  }

  const iam = `arn:${partition}:iam::${accountId}`
  const ssm = `arn:${partition}:ssm:${region}:${accountId}`
  const secrets = `arn:${partition}:secretsmanager:${region}:${accountId}`
  const ec2 = `arn:${partition}:ec2:${region}:${accountId}`
  const boundaryArn = `${iam}:policy/boxlite-${stage}-runtime-boundary`
  const runtimeSecretResource = `${secrets}:secret:boxlite-${stage}-runtime/*`
  const operationLockResource = `${ssm}:parameter/boxlite/${stage}/deployment-operation-lock`

  const expected = [
    {
      Sid: 'DenyOtherParameterMutation',
      Effect: 'Deny',
      Action: [
        'ssm:AddTagsToResource',
        'ssm:DeleteParameter',
        'ssm:DeleteParameters',
        'ssm:LabelParameterVersion',
        'ssm:PutParameter',
        'ssm:RemoveTagsFromResource',
        'ssm:UnlabelParameterVersion',
      ],
      NotResource: [operationLockResource, `${ssm}:parameter/boxlite/${stage}/sst-secret-status/*`],
    },
    {
      Sid: 'DenyParameterResourcePolicyMutation',
      Effect: 'Deny',
      Action: ['ssm:DeleteResourcePolicy', 'ssm:PutResourcePolicy'],
      Resource: '*',
    },
    {
      Sid: 'ReadCloudflareProviderCredentials',
      Effect: 'Allow',
      Action: 'ssm:GetParameter',
      Resource: [
        `${ssm}:parameter/boxlite/${stage}/cloudflare-api-token`,
        `${ssm}:parameter/boxlite/${stage}/cloudflare-account-id`,
      ],
    },
    {
      Sid: 'UseBoxLiteSstSecretStatus',
      Effect: 'Allow',
      Action: ['ssm:GetParameter', 'ssm:PutParameter'],
      Resource: `${ssm}:parameter/boxlite/${stage}/sst-secret-status/*`,
    },
    {
      Sid: 'UseRunnerCommandDocument',
      Effect: 'Allow',
      Action: 'ssm:SendCommand',
      Resource: `arn:${partition}:ssm:${region}::document/AWS-RunShellScript`,
    },
    { Sid: 'ReadSystemsManagerCommandResult', Effect: 'Allow', Action: 'ssm:GetCommandInvocation', Resource: '*' },
    {
      Sid: 'ReadSelectedStageRuntimeSecrets',
      Effect: 'Allow',
      Action: ['secretsmanager:DescribeSecret', 'secretsmanager:GetResourcePolicy', 'secretsmanager:GetSecretValue'],
      Resource: runtimeSecretResource,
    },
    {
      Sid: 'DenyRuntimeSecretLifecycleMutation',
      Effect: 'Deny',
      NotAction: [
        'secretsmanager:DescribeSecret',
        'secretsmanager:GetResourcePolicy',
        'secretsmanager:GetSecretValue',
        'secretsmanager:PutSecretValue',
      ],
      Resource: runtimeSecretResource,
    },
    {
      Sid: 'ManageSelectedStageStackSecrets',
      Effect: 'Allow',
      Action: [
        'secretsmanager:CancelRotateSecret',
        'secretsmanager:CreateSecret',
        'secretsmanager:DeleteSecret',
        'secretsmanager:DescribeSecret',
        'secretsmanager:GetResourcePolicy',
        'secretsmanager:GetSecretValue',
        'secretsmanager:ListSecretVersionIds',
        'secretsmanager:PutSecretValue',
        'secretsmanager:RestoreSecret',
        'secretsmanager:RotateSecret',
        'secretsmanager:TagResource',
        'secretsmanager:UntagResource',
        'secretsmanager:UpdateSecret',
        'secretsmanager:UpdateSecretVersionStage',
      ],
      Resource: [
        `${secrets}:secret:boxlite-${stage}-DatabaseProxySecret-*`,
        `${secrets}:secret:boxlite-${stage}-CacheProxySecret-*`,
        `${secrets}:secret:boxlite-${stage}-GhcrPullToken-*`,
      ],
    },
    {
      Sid: 'DenyBoxLiteSecretResourcePolicyMutation',
      Effect: 'Deny',
      Action: ['secretsmanager:DeleteResourcePolicy', 'secretsmanager:PutResourcePolicy'],
      Resource: `${secrets}:secret:boxlite-*`,
    },
    {
      Sid: 'ReadBoxLiteDeploymentConfig',
      Effect: 'Allow',
      Action: 'ssm:GetParameter',
      Resource: `${ssm}:parameter/boxlite/${stage}/deploy-config/*`,
    },
    {
      Sid: 'DenyBoxLiteDeploymentConfigMutation',
      Effect: 'Deny',
      NotAction: 'ssm:GetParameter',
      Resource: `${ssm}:parameter/boxlite/*/deploy-config/*`,
    },
    {
      Sid: 'UseBoxLiteDeploymentOperationLock',
      Effect: 'Allow',
      Action: ['ssm:DeleteParameter', 'ssm:GetParameter', 'ssm:PutParameter'],
      Resource: operationLockResource,
    },
    {
      Sid: 'DenyOtherBoxLiteDeploymentOperationLockActions',
      Effect: 'Deny',
      NotAction: ['ssm:DeleteParameter', 'ssm:GetParameter', 'ssm:PutParameter'],
      Resource: operationLockResource,
    },
    {
      Sid: 'ReadIamAndAccountMetadata',
      Effect: 'Allow',
      Action: [
        'cloudformation:DescribeStacks',
        'iam:GetInstanceProfile',
        'iam:GetPolicy',
        'iam:GetPolicyVersion',
        'iam:GetRole',
        'iam:GetRolePolicy',
        'iam:ListAttachedRolePolicies',
        'iam:ListInstanceProfilesForRole',
        'iam:ListPolicyVersions',
        'iam:ListRoles',
        'iam:ListRolePolicies',
        'iam:ListRoleTags',
        'sts:GetCallerIdentity',
      ],
      Resource: '*',
    },
    {
      Sid: 'CreateBoundedBoxLiteRoles',
      Effect: 'Allow',
      Action: 'iam:CreateRole',
      Resource: `${iam}:role/boxlite-${stage}-*`,
      Condition: { StringEquals: { 'iam:PermissionsBoundary': boundaryArn } },
    },
    {
      Sid: 'DenyGitHubDeployRoleMutation',
      Effect: 'Deny',
      NotAction: [
        'iam:GetRole',
        'iam:GetRolePolicy',
        'iam:ListAttachedRolePolicies',
        'iam:ListInstanceProfilesForRole',
        'iam:ListRolePolicies',
        'iam:ListRoleTags',
      ],
      Resource: `${iam}:role/boxlite-*-github-deploy`,
    },
    {
      Sid: 'ManageBoxLiteRoles',
      Effect: 'Allow',
      Action: [
        'iam:AttachRolePolicy',
        'iam:CreateInstanceProfile',
        'iam:DeleteInstanceProfile',
        'iam:DeleteRole',
        'iam:DeleteRolePolicy',
        'iam:DetachRolePolicy',
        'iam:PutRolePolicy',
        'iam:RemoveRoleFromInstanceProfile',
        'iam:AddRoleToInstanceProfile',
        'iam:TagInstanceProfile',
        'iam:TagRole',
        'iam:UntagInstanceProfile',
        'iam:UntagRole',
        'iam:UpdateAssumeRolePolicy',
        'iam:UpdateRole',
        'iam:UpdateRoleDescription',
      ],
      Resource: [`${iam}:role/boxlite-${stage}-*`, `${iam}:instance-profile/boxlite-${stage}-*`],
    },
    {
      Sid: 'PassSelectedStageRuntimeRoles',
      Effect: 'Allow',
      Action: 'iam:PassRole',
      Resource: `${iam}:role/boxlite-${stage}-*`,
      Condition: { StringEquals: { 'iam:PassedToService': ['ec2.amazonaws.com', 'ecs-tasks.amazonaws.com'] } },
    },
    {
      Sid: 'SetBoxLiteRoleBoundary',
      Effect: 'Allow',
      Action: 'iam:PutRolePermissionsBoundary',
      Resource: `${iam}:role/boxlite-${stage}-*`,
      Condition: { StringEquals: { 'iam:PermissionsBoundary': boundaryArn } },
    },
    {
      Sid: 'DenyRuntimeBoundaryMutation',
      Effect: 'Deny',
      NotAction: [
        'iam:GetPolicy',
        'iam:GetPolicyVersion',
        'iam:ListEntitiesForPolicy',
        'iam:ListPolicyTags',
        'iam:ListPolicyVersions',
      ],
      Resource: `${iam}:policy/boxlite-*-runtime-boundary`,
    },
    {
      Sid: 'ManageBoxLitePolicies',
      Effect: 'Allow',
      Action: [
        'iam:CreatePolicy',
        'iam:CreatePolicyVersion',
        'iam:DeletePolicy',
        'iam:DeletePolicyVersion',
        'iam:SetDefaultPolicyVersion',
        'iam:TagPolicy',
        'iam:UntagPolicy',
      ],
      Resource: `${iam}:policy/boxlite-${stage}-*`,
    },
    {
      Sid: 'CreateRequiredServiceLinkedRoles',
      Effect: 'Allow',
      Action: 'iam:CreateServiceLinkedRole',
      Resource: `arn:${partition}:iam::*:role/aws-service-role/*`,
      Condition: {
        StringEquals: {
          'iam:AWSServiceName': [
            'autoscaling.amazonaws.com',
            'ecs.amazonaws.com',
            'elasticloadbalancing.amazonaws.com',
            'rds.amazonaws.com',
          ],
        },
      },
    },
  ]

  const selectedRunnerCommand = statements.has('SendSelectedStageRunnerCommand')
  const legacyRunnerCommand = statements.has('SendLegacyRunnerCommand')
  if (selectedRunnerCommand === legacyRunnerCommand) {
    throw new Error('deploy policy contract must select exactly one Runner command gate')
  }
  if (selectedRunnerCommand) {
    expected.push(
      {
        Sid: 'SendSelectedStageRunnerCommand',
        Effect: 'Allow',
        Action: 'ssm:SendCommand',
        Resource: `${ec2}:instance/*`,
        Condition: {
          StringEquals: {
            'ssm:resourceTag/boxlite:stage': stage,
            'ssm:resourceTag/boxlite:ssm-role': 'runner',
          },
        },
      },
      {
        Sid: 'DenyRunnerCommandAuthorizationTagMutation',
        Effect: 'Deny',
        Action: ['ec2:CreateTags', 'ec2:DeleteTags'],
        Resource: `${ec2}:instance/*`,
        Condition: {
          'ForAnyValue:StringEqualsIgnoreCase': { 'aws:TagKeys': ['boxlite:stage', 'boxlite:ssm-role'] },
          StringNotEqualsIfExists: { 'ec2:CreateAction': 'RunInstances' },
        },
      },
    )
  } else {
    if (statements.has('DenyRunnerCommandAuthorizationTagMutation')) {
      throw new Error('deploy policy contract cannot protect Runner tags before the command tag gate is enabled')
    }
    expected.push({
      Sid: 'SendLegacyRunnerCommand',
      Effect: 'Allow',
      Action: 'ssm:SendCommand',
      Resource: `${ec2}:instance/*`,
    })
  }

  const initializesRuntimeSecrets = statements.has('InitializeGeneratedPendingRuntimeSecrets')
  const deniesRuntimeInitialization = statements.has('DenyRuntimeSecretInitialization')
  if (initializesRuntimeSecrets === deniesRuntimeInitialization) {
    throw new Error('deploy policy contract must select exactly one runtime-secret initialization gate')
  }
  expected.push(
    initializesRuntimeSecrets
      ? {
          Sid: 'InitializeGeneratedPendingRuntimeSecrets',
          Effect: 'Allow',
          Action: 'secretsmanager:PutSecretValue',
          Resource: runtimeSecretResource,
          Condition: {
            StringEquals: {
              'secretsmanager:ResourceTag/boxlite:initial-value': 'generated',
              'secretsmanager:ResourceTag/boxlite:initialization': 'pending',
            },
          },
        }
      : {
          Sid: 'DenyRuntimeSecretInitialization',
          Effect: 'Deny',
          Action: 'secretsmanager:PutSecretValue',
          Resource: runtimeSecretResource,
        },
  )

  for (const statement of expected) assertExactPolicyStatement(statements, statement)

  const reviewedSensitiveSids = new Set(expected.map(({ Sid }) => Sid))
  for (const statement of policyDocument.Statement) {
    if (reviewedSensitiveSids.has(statement.Sid)) continue
    const actions = asArray(statement.Action)
    const hasSensitiveAction = actions.some((action) => {
      if (typeof action !== 'string') return true
      const service = action.split(':', 1)[0]
      return (
        action === '*' ||
        action === '*:*' ||
        service.includes('*') ||
        service.includes('?') ||
        /^(?:cloudformation|iam|secretsmanager|ssm|sts)$/i.test(service)
      )
    })
    // An Allow/NotAction grants every action except the listed set. Even a Deny/NotAction can
    // silently weaken one of the reviewed deny shapes, so no unreviewed NotAction is acceptable.
    if (statement.NotAction !== undefined || hasSensitiveAction) {
      throw new Error(`deploy policy contract contains unreviewed sensitive access in ${statement.Sid}`)
    }
  }
  return {
    runnerCommandTagGateEnabled: selectedRunnerCommand,
    runtimeSecretInitializationEnabled: initializesRuntimeSecrets,
  }
}

export function assertSelectedStageRolesBounded({ roles, accountId, stage, appName = 'boxlite' }) {
  if (!Array.isArray(roles)) throw new Error('IAM role inventory must be an array')
  const expectedDeployRole = `${appName}-${stage}-github-deploy`
  const namespacePrefix = `${appName}-${stage}-`
  const boundaryArn = runtimeBoundaryPolicyArn({ accountId, appName, stage })
  const seen = new Set()
  let foundDeployRole = false

  for (const role of roles) {
    const roleName = role?.RoleName
    if (typeof roleName !== 'string' || seen.has(roleName)) {
      throw new Error('IAM role inventory contains an invalid or duplicate role')
    }
    seen.add(roleName)
    if (!roleName.startsWith(namespacePrefix)) continue
    if (roleName === expectedDeployRole) {
      foundDeployRole = true
      continue
    }
    if (role.PermissionsBoundary?.PermissionsBoundaryArn !== boundaryArn) {
      throw new Error(`selected-stage role '${roleName}' does not carry the required runtime boundary`)
    }
  }
  if (!foundDeployRole) throw new Error(`IAM role inventory does not contain '${expectedDeployRole}'`)
  return { boundaryArn, roleCount: [...seen].filter((name) => name.startsWith(namespacePrefix)).length }
}

function iamPatternToRegExp(pattern) {
  if (typeof pattern !== 'string') return /(?!)/ // matches nothing
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

/*
 * IAM treats condition *key names* case-insensitively, so a policy written with
 * `iam:PermissionsBoundary` must match a lookup for `IAM:PermissionsBoundary`.
 * Only the key is folded — the values `StringEquals` compares stay
 * case-sensitive, which is why the caller still uses an exact `includes`.
 */
function stringEqualsValues(condition, conditionKey) {
  const stringEquals = condition?.StringEquals
  if (!stringEquals) return undefined
  const wanted = conditionKey.toLowerCase()
  const match = Object.keys(stringEquals).find((key) => key.toLowerCase() === wanted)
  return match === undefined ? undefined : stringEquals[match]
}

/*
 * Recognizes the `Condition.StringEquals` operator the actual template uses
 * (SetBoxLiteRoleBoundary in ci/github-deploy-role.yaml). A statement with no
 * condition on `conditionKey` is an unconditional — and therefore sufficient
 * — grant of the action; a policy redesigned around a different condition
 * operator would need this updated too.
 */
export function policyDocumentsAllow(policyDocuments, { action, resource, conditionKey, conditionValue }) {
  for (const document of policyDocuments) {
    for (const statement of asArray(document?.Statement)) {
      if (statement?.Effect !== 'Allow') continue
      if (!asArray(statement.Action).some((pattern) => iamPatternToRegExp(pattern).test(action))) continue
      if (!asArray(statement.Resource).some((pattern) => iamPatternToRegExp(pattern).test(resource))) continue

      const requiredValues = stringEqualsValues(statement.Condition, conditionKey)
      if (requiredValues === undefined || asArray(requiredValues).includes(conditionValue)) return true
    }
  }
  return false
}

/**
 * @param {{
 *   callerArn: string,        // sts:GetCallerIdentity Arn
 *   accountId: string,        // sts:GetCallerIdentity Account
 *   stage: string,
 *   policyDocuments: object[],// parsed IAM PolicyDocument JSON (inline + managed, current version)
 *   appName?: string,
 * }} args
 */
export function verifyDeployRoleGrantsBoundaryPermission({ callerArn, accountId, stage, policyDocuments, appName = 'boxlite' }) {
  const roleName = parseAssumedRoleName(callerArn)
  const boundaryArn = runtimeBoundaryPolicyArn({ accountId, appName, stage })
  // A synthetic-but-representative role ARN under the namespace SST creates
  // roles in — not a real resource, just something the policy's `role/
  // boxlite-*`-style Resource pattern should match.
  const probeResource = `arn:aws:iam::${accountId}:role/${appName}-${stage}-verify-probe`

  const grants = policyDocumentsAllow(policyDocuments, {
    action: 'iam:PutRolePermissionsBoundary',
    resource: probeResource,
    conditionKey: 'iam:PermissionsBoundary',
    conditionValue: boundaryArn,
  })
  return { roleName, boundaryArn, grants }
}
