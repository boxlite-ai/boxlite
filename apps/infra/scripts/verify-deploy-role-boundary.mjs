// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * CI preflight: confirm the assumed deploy role comes from a completed
 * bootstrap stack, matches the reviewed live policy contract, and can attach
 * the runtime IAM permissions boundary before `sst diff`/`sst deploy` run.
 * apps/infra/sst.config.ts requires every role it manages to carry that
 * boundary (see the $transform there); if the bootstrap CloudFormation
 * stack (ci/github-deploy-role.yaml, provisioned by
 * scripts/bootstrap-environment.mjs) was never (re)deployed for this role,
 * every one of those roles fails identically with an
 * iam:PutRolePermissionsBoundary AccessDenied — a ~2-minute wall of
 * duplicate errors, discovered only after install + tests + preview already
 * ran. This step catches the same gap in seconds, using only the read-only
 * IAM actions the deploy role already has (ReadIamAndAccountMetadata in
 * ci/github-deploy-role.yaml).
 *
 * Usage: node scripts/verify-deploy-role-boundary.mjs
 * Reads the SST stage from IAM_PERMISSIONS_BOUNDARY_STAGE (already required
 * in the deploy workflow's job-level env, and by sst.config.ts itself).
 */

import { execFileSync } from 'node:child_process'

import {
  assertDeployPolicyContract,
  assertDeployRoleStackComplete,
  assertDeployRoleTopology,
  assertSelectedStageRolesBounded,
  parseAssumedRoleIdentity,
  parseAssumedRoleName,
  verifyDeployRoleGrantsBoundaryPermission,
} from './deploy-role-boundary.mjs'
import { githubDeployRoleStackName } from './environment-bootstrap.mjs'
import { resolveAwsRegion } from './deployment-environment.mjs'
import { resolveAwsCliPath } from './proxy-deployment-verify.mjs'

const SCRIPT_NAME = 'verify-deploy-role-boundary'

function requireStage(environment = process.env) {
  const stage = environment.IAM_PERMISSIONS_BOUNDARY_STAGE
  if (!stage) throw new Error('IAM_PERMISSIONS_BOUNDARY_STAGE is required to identify the provisioned runtime boundary')
  return stage
}

function awsJson(awsCliPath, region, args) {
  const stdout = execFileSync(awsCliPath, [...args, '--region', region, '--output', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
    killSignal: 'SIGTERM',
  })
  return JSON.parse(stdout)
}

function fetchDeployPolicyDocument(awsCliPath, region, roleName, stage) {
  const { Role } = awsJson(awsCliPath, region, ['iam', 'get-role', '--role-name', roleName])
  const { PolicyNames } = awsJson(awsCliPath, region, ['iam', 'list-role-policies', '--role-name', roleName])
  const { AttachedPolicies } = awsJson(awsCliPath, region, ['iam', 'list-attached-role-policies', '--role-name', roleName])
  const topology = assertDeployRoleTopology({
    roleName,
    stage,
    inlinePolicyNames: PolicyNames,
    attachedPolicyArns: AttachedPolicies.map(({ PolicyArn }) => PolicyArn),
    roleTags: Role?.Tags,
  })
  return awsJson(awsCliPath, region, [
    'iam',
    'get-role-policy',
    '--role-name',
    roleName,
    '--policy-name',
    topology.policyName,
  ]).PolicyDocument
}

function fetchAllRoles(awsCliPath, region) {
  const roles = []
  const seenMarkers = new Set()
  let marker
  do {
    const response = awsJson(awsCliPath, region, [
      'iam',
      'list-roles',
      '--no-paginate',
      ...(marker ? ['--marker', marker] : []),
    ])
    if (!Array.isArray(response.Roles) || typeof response.IsTruncated !== 'boolean') {
      throw new Error('IAM list-roles returned an invalid pagination response')
    }
    roles.push(...response.Roles)
    if (!response.IsTruncated) {
      if (response.Marker !== undefined && response.Marker !== null && response.Marker !== '') {
        throw new Error('IAM list-roles returned an unexpected final marker')
      }
      marker = undefined
      continue
    }
    if (typeof response.Marker !== 'string' || !response.Marker || seenMarkers.has(response.Marker)) {
      throw new Error('IAM list-roles returned an invalid or repeated pagination marker')
    }
    seenMarkers.add(response.Marker)
    marker = response.Marker
  } while (marker)
  return roles
}

function main() {
  // CI and local operators supply stage/region explicitly. This preflight must
  // not consult the bootstrap-only local environment file.
  const region = resolveAwsRegion()
  const stage = requireStage()
  const awsCliPath = resolveAwsCliPath()

  let identity
  try {
    identity = awsJson(awsCliPath, region, ['sts', 'get-caller-identity'])
  } catch (cause) {
    throw new Error('could not call `aws sts get-caller-identity`', { cause })
  }

  let policyDocuments
  let policyContract
  let stackStatus
  try {
    const assumedRole = parseAssumedRoleIdentity(identity.Arn)
    if (identity.Account !== assumedRole.accountId) throw new Error('caller ARN and account do not match')
    const roleName = assumedRole.roleName
    const stack = awsJson(awsCliPath, region, [
      'cloudformation',
      'describe-stacks',
      '--stack-name',
      githubDeployRoleStackName(stage),
    ])
    stackStatus = assertDeployRoleStackComplete({ stage, stacks: stack.Stacks })
    policyDocuments = [fetchDeployPolicyDocument(awsCliPath, region, roleName, stage)]
    policyContract = assertDeployPolicyContract({
      policyDocument: policyDocuments[0],
      accountId: identity.Account,
      partition: assumedRole.partition,
      region,
      stage,
    })
    assertSelectedStageRolesBounded({ roles: fetchAllRoles(awsCliPath, region), accountId: identity.Account, stage })
  } catch (cause) {
    throw new Error(`could not read the deploy role's IAM policies for stage '${stage}'`, { cause })
  }

  const { roleName, boundaryArn, grants } = verifyDeployRoleGrantsBoundaryPermission({
    callerArn: identity.Arn,
    accountId: identity.Account,
    stage,
    policyDocuments,
  })

  if (!grants) {
    throw new Error(
      `deploy role '${roleName}' has no policy statement allowing iam:PutRolePermissionsBoundary for ` +
        `${boundaryArn} on role/boxlite-*. apps/infra/sst.config.ts requires every SST-managed role to carry ` +
        `this boundary. Run \`node scripts/bootstrap-environment.mjs --stage ${stage}\` with AWS admin ` +
        'credentials (it redeploys ci/github-deploy-role.yaml), then confirm the GitHub environment variable ' +
        `AWS_DEPLOY_ROLE_ARN for '${stage}' still points at that stack's RoleArn output. ` +
        'See apps/infra/README.md#deploy-an-existing-stack.',
    )
  }

  console.log(
    `[${SCRIPT_NAME}] ${roleName} has the reviewed live policy (${stackStatus.stackStatus}; ` +
      `runner-tag-gate=${policyContract.runnerCommandTagGateEnabled}; ` +
      `runtime-secret-init=${policyContract.runtimeSecretInitializationEnabled}) and grants ` +
      `iam:PutRolePermissionsBoundary for ${boundaryArn}`,
  )
}

try {
  main()
} catch (error) {
  // Print the cause chain: failures here are wrapped with `{ cause }`, and the
  // wrapper text alone ("could not read the deploy role's IAM policies") does
  // not say whether the ARN was the wrong shape or the AWS CLI itself failed.
  console.error(`${SCRIPT_NAME}: ${error.message}`)
  for (let cause = error.cause; cause; cause = cause.cause) {
    console.error(`${SCRIPT_NAME}:   caused by: ${cause.message ?? cause}`)
  }
  process.exit(1)
}
