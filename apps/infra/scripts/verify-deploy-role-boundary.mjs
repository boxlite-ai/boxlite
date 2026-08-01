// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * CI preflight: confirm the assumed deploy role can actually attach the
 * runtime IAM permissions boundary before `sst diff`/`sst deploy` run.
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

import { parseAssumedRoleName, verifyDeployRoleGrantsBoundaryPermission } from './deploy-role-boundary.mjs'
import { loadDeploymentEnvironment, resolveAwsRegion } from './deployment-environment.mjs'
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

function fetchInlinePolicyDocuments(awsCliPath, region, roleName) {
  const { PolicyNames } = awsJson(awsCliPath, region, ['iam', 'list-role-policies', '--role-name', roleName])
  return PolicyNames.map(
    (policyName) =>
      awsJson(awsCliPath, region, ['iam', 'get-role-policy', '--role-name', roleName, '--policy-name', policyName])
        .PolicyDocument,
  )
}

function fetchAttachedManagedPolicyDocuments(awsCliPath, region, roleName) {
  const { AttachedPolicies } = awsJson(awsCliPath, region, ['iam', 'list-attached-role-policies', '--role-name', roleName])
  return AttachedPolicies.map(({ PolicyArn }) => {
    const { Policy } = awsJson(awsCliPath, region, ['iam', 'get-policy', '--policy-arn', PolicyArn])
    const { PolicyVersion } = awsJson(awsCliPath, region, [
      'iam',
      'get-policy-version',
      '--policy-arn',
      PolicyArn,
      '--version-id',
      Policy.DefaultVersionId,
    ])
    return PolicyVersion.Document
  })
}

function main() {
  // CI supplies these as job env, but `npm run verify-deploy-role` locally
  // needs the stage dotenv.
  loadDeploymentEnvironment()
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
  try {
    const roleName = parseAssumedRoleName(identity.Arn)
    policyDocuments = [
      ...fetchInlinePolicyDocuments(awsCliPath, region, roleName),
      ...fetchAttachedManagedPolicyDocuments(awsCliPath, region, roleName),
    ]
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

  console.log(`[${SCRIPT_NAME}] ${roleName} grants iam:PutRolePermissionsBoundary for ${boundaryArn}`)
}

try {
  main()
} catch (error) {
  console.error(`${SCRIPT_NAME}: ${error.message}`)
  process.exit(1)
}
