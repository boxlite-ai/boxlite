// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * How the Api image repository and the Runner artifacts bucket are spelled.
 *
 *   <namespace>-<workload>-<stage>-<name>[-<attribute>...]
 *
 * The workload slot exists because the account holds more than one: the application stack, the
 * ops console (boxlite-ops-console*), and the e2e fleet (boxlite-e2e-*). Without it nothing
 * distinguishes a workload token from a stage — `boxlite-e2e-runner` reads equally as stage=e2e
 * or workload=e2e — and a reader cannot parse a name back into its parts.
 *
 * Most files that touch one of these two names go through awsResourceName; the exceptions are
 * the ones that cannot call JavaScript: ci/github-deploy-role.yaml declares both,
 * deploy-infra.yml writes the bucket into a shell variable, and build-apps-api-image.yml writes
 * the Api image name. Everything else, this module's two callers (api-artifact.mjs,
 * runner-artifact.mjs) and their callers, never re-spells the string. The in-repo spellings are
 * what release-deployment-safety.test.mjs pins, which is what turns a drift into a test failure
 * instead of a deploy that cannot find its own artifact.
 *
 * A fourth place is easy to miss and is not a spelling at all: ci/github-deploy-role.yaml's
 * runtime permissions boundary allows S3 by ARN prefix. A boundary intersects with every identity
 * policy, so a bucket outside its prefixes is denied whatever the stack grants — renaming without
 * widening it denied the Runner its own binary while every test stayed green.
 *
 * Deliberately NOT applied to the other AWS names this repository owns, each for its own reason:
 *
 *   boxlite-<stage>-github-deploy    live, and its ARN is stored in the dev GitHub environment
 *                                    variable AWS_DEPLOY_ROLE_ARN, so renaming needs a re-bootstrap
 *   boxlite-<stage>-runtime-boundary live, and attached as a permissions boundary to existing
 *                                    roles, so renaming the policy is a migration
 *   SST-managed resources            SST derives <app>-<stage>-<LogicalId>-<hash> from the app
 *                                    name, so moving those means renaming the SST app and
 *                                    replacing every resource it manages
 *
 * The first two are ordinary CloudFormation resources, not SST-named — they are excluded because
 * they already exist and are referenced elsewhere, not because anything makes them unrenamable.
 */

// The application stack, as distinct from the ops-console and e2e workloads in the same account.
const WORKLOAD = 'app'

export function awsResourceName({ app, stage, name, attributes = [] }) {
  return [app, WORKLOAD, stage, name, ...attributes].join('-')
}
