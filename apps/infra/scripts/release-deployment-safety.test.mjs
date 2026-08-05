// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { DEFAULT_SCHEMA, Type, load } from 'js-yaml'

import { verifyDeployRoleGrantsBoundaryPermission } from './deploy-role-boundary.mjs'
import { liveText } from './live-source.mjs'
import { apiImageRepository } from './api-artifact.mjs'
import { runnerArtifactsBucketName } from './runner-artifact.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SST_WRAPPER = join(REPO_ROOT, 'apps/infra/scripts/sst-with-cloudflare.mjs')
const RUNNER_POLICY_PROJECT = join(REPO_ROOT, 'apps/infra/PulumiPolicy.yaml')
const RUNNER_POLICY_ENTRY = join(REPO_ROOT, 'apps/infra/policies/runner/index.js')
const RUNNER_POLICY_DEFINITIONS = join(REPO_ROOT, 'apps/infra/policies/runner/definitions.cjs')
const DEPLOY_WORKFLOW = join(REPO_ROOT, '.github/workflows/deploy-infra.yml')
const RELEASE_DEPLOY_WORKFLOW = join(REPO_ROOT, '.github/workflows/deploy-release.yml')
const API_IMAGE_BUILD_WORKFLOW = join(REPO_ROOT, '.github/workflows/build-apps-api-image.yml')
const BUILD_C_WORKFLOW = join(REPO_ROOT, '.github/workflows/build-c.yml')
const BUILD_RUNNER_WORKFLOW = join(REPO_ROOT, '.github/workflows/build-runner-binary.yml')
const E2E_CLOUD_WORKFLOW = join(REPO_ROOT, '.github/workflows/e2e-cloud.yml')
const LINT_WORKFLOW = join(REPO_ROOT, '.github/workflows/lint.yml')
const DEV_DEPLOY_ROLE = join(REPO_ROOT, 'apps/infra/ci/github-deploy-role.yaml')
const CLOUDFORMATION_SCHEMA = DEFAULT_SCHEMA.extend([
  new Type('!Sub', {
    kind: 'scalar',
    construct: (value) => value,
  }),
  new Type('!Ref', {
    kind: 'scalar',
    construct: (value) => value,
  }),
  new Type('!GetAtt', {
    kind: 'scalar',
    construct: (value) => value,
  }),
])
const requireFromTest = createRequire(import.meta.url)

// One decision per artifact kind, made where the text is read (see live-source.mjs).
const liveShell = (run) => liveText('shell', run)
const assertShellLine = (run, pattern, message) =>
  assert.match(liveShell(run), pattern, message ?? `missing live shell: ${pattern}`)
const assertLiveLine = (text, pattern, message) =>
  assert.match(liveText('script', text), pattern, message ?? `missing live line: ${pattern}`)

function readDeployTemplate() {
  return load(readFileSync(DEV_DEPLOY_ROLE, 'utf8'), { schema: CLOUDFORMATION_SCHEMA })
}

function readRuntimeBoundaryStatements() {
  return readDeployTemplate().Resources.BoxLiteRuntimePermissionsBoundary.Properties.PolicyDocument.Statement
}

function findStatement(statements, sid) {
  const statement = statements.find((candidate) => candidate.Sid === sid)
  assert.ok(statement, `missing ${sid} statement`)
  return statement
}

test('SST deploy verifies the selected Runner artifact before invoking SST', () => {
  const source = readFileSync(SST_WRAPPER, 'utf8')
  const preflightIndex = source.indexOf('await verifyRunnerArtifact(')
  const sstIndex = source.indexOf('await withPulumiEventLogCleanup(')

  assert.match(source, /requireCheckoutMatchesArtifactRefs, resolveArtifactSource \} from '\.\/artifact-source\.mjs'/)
  // The import is not the behavior: commenting the call out leaves the import, and a build deploy
  // would then ship the Proxy and the OtelCollector from this checkout while the Api and the
  // Runner are addressed by a ref that names a different commit.
  //
  // Both sources, not one: a Runner-only build addresses no Api ref, so passing `apiSource` alone
  // would skip the check for exactly the deploy `npm run runner:build-artifact` produces.
  assertLiveLine(source, /requireCheckoutMatchesArtifactRefs\(\[apiSource, runnerSource\]\)/)
  assert.match(source, /verifyRunnerArtifact \} from '\.\/runner-artifact\.mjs'/)
  assert.match(source, /const runnerSource = resolveArtifactSource\('runner'/)
  assert.notEqual(preflightIndex, -1, 'the Runner artifact preflight is missing')
  assert.notEqual(sstIndex, -1, 'the guarded SST invocation is missing')
  assert.ok(preflightIndex < sstIndex, 'SST may run before Runner artifact availability is known')
  assert.doesNotMatch(source, /isSstComponentExcluded/)
  assert.match(source, /requireFullStackDeploy\(sstArgs\)/)
  assert.match(source, /withRequiredRunnerPolicy\(sstArgs\)/)
  assert.doesNotMatch(source, /RUNNER_POLICY_ROOT/)
})

test('preview and deploy use the mandatory local Runner policy', () => {
  assert.ok(existsSync(RUNNER_POLICY_PROJECT), 'PulumiPolicy.yaml is missing')
  assert.ok(existsSync(RUNNER_POLICY_ENTRY), 'the Runner policy entry point is missing')
  assert.ok(existsSync(RUNNER_POLICY_DEFINITIONS), 'the Runner policy definitions are missing')
  assert.deepEqual(load(readFileSync(RUNNER_POLICY_PROJECT, 'utf8')), {
    runtime: 'nodejs',
    main: 'policies/runner/index.js',
    description: 'Mandatory BoxLite Runner lifecycle and identity policy',
  })

  const policySource = readFileSync(RUNNER_POLICY_ENTRY, 'utf8')
  const policyDefinitions = readFileSync(RUNNER_POLICY_DEFINITIONS, 'utf8')
  assert.match(policySource, /new PolicyPack\('boxlite-runner-safety'/)
  assert.match(policySource, /serializedRunnerStateBaseline = process\.env\.BOXLITE_RUNNER_STATE_BASELINE/)
  assert.match(policySource, /parseRunnerStateBaseline\(serializedRunnerStateBaseline\)/)
  assert.match(policySource, /policies: createRunnerPolicies\(runnerInventory, runnerStateBaseline\)/)
  assert.equal(policyDefinitions.match(/enforcementLevel: 'mandatory'/g)?.length, 2)

  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'apps/infra/package.json'), 'utf8'))
  const packageLock = JSON.parse(readFileSync(join(REPO_ROOT, 'apps/infra/package-lock.json'), 'utf8'))
  assert.equal(packageJson.main, 'policies/runner/index.js')
  assert.ok(existsSync(join(REPO_ROOT, 'apps/infra', packageJson.main)), 'the Node policy entry point is missing')
  assert.equal(requireFromTest.resolve(join(REPO_ROOT, 'apps/infra')), RUNNER_POLICY_ENTRY)
  assert.equal(packageJson.devDependencies['@pulumi/policy'], '1.21.0')
  assert.equal(packageLock.packages[''].devDependencies['@pulumi/policy'], '1.21.0')
})

test('SST deploy verifies the selected API image before invoking SST', () => {
  // Over live source: unlike the Runner preflight, nothing executes this path in a test, so a
  // commented-out call would otherwise leave both indices and the ordering intact.
  const source = liveText('script', readFileSync(SST_WRAPPER, 'utf8'))
  const preflightIndex = source.indexOf('const image = verifyApiImage(')
  const sstIndex = source.indexOf('await withPulumiEventLogCleanup(')

  assert.match(source, /const apiSource = resolveArtifactSource\('api'\)/)
  assert.notEqual(preflightIndex, -1, 'the API image preflight is missing')
  assert.ok(preflightIndex < sstIndex, 'SST may run before the selected API image is known to exist')
  // Both published sources go through it. Gating on release alone would let a build deploy name a
  // commit tag nothing ever pushed, and discover it when the ECS task fails to pull.
  assertLiveLine(source, /if \(apiSource\.kind === 'release' \|\| apiSource\.ref\) \{/)
})

test('SST deploy does not depend on a laptop-managed remote builder', () => {
  const source = readFileSync(SST_WRAPPER, 'utf8')
  const packageSource = readFileSync(join(REPO_ROOT, 'apps/infra/package.json'), 'utf8')

  assert.doesNotMatch(source, /RemoteAmd64Builder/)
  assert.doesNotMatch(source, /BUILDX_BUILDER/)
  assert.doesNotMatch(packageSource, /builder:(?:provision|start|status|stop)/)
  for (const legacyPath of [
    'apps/infra/scripts/buildx-builder.mjs',
    'apps/infra/scripts/buildx-builder-cli.mjs',
    'apps/infra/buildkit/amd64-builder.yaml',
    'apps/infra/buildkit/buildkitd.toml',
  ]) {
    assert.equal(existsSync(join(REPO_ROOT, legacyPath)), false, `${legacyPath} must be removed`)
  }
})

test('deployment previews and reconciles the full stack in guarded GitHub CI', () => {
  assert.ok(existsSync(DEPLOY_WORKFLOW), 'the stack deployment workflow is missing')
  const source = readFileSync(DEPLOY_WORKFLOW, 'utf8')
  const workflow = load(source)
  const safetyTestStep = workflow.jobs.deploy.steps.find((step) => step.name === 'Run deployment safety tests')
  const boundaryCheckStep = workflow.jobs.deploy.steps.find(
    (step) => step.name === 'Verify deploy role IAM boundary permissions',
  )
  const materializeStep = workflow.jobs.deploy.steps.find((step) => step.name === 'Materialize stage configuration')
  const installStep = workflow.jobs.deploy.steps.find((step) => step.name === 'Install SST providers')
  const previewStep = workflow.jobs.deploy.steps.find((step) => step.name === 'Preview the full stack')
  const deployStep = workflow.jobs.deploy.steps.find((step) => step.name === 'Deploy the full stack')

  assert.match(source, /workflow_dispatch:/)
  assert.equal(workflow.on.workflow_dispatch.inputs.stage.type, 'choice')
  assert.ok(workflow.on.workflow_dispatch.inputs.stage.options.includes('dev'))
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.apply, {
    description: 'Preview again, then deploy the full stack',
    required: true,
    default: false,
    type: 'boolean',
  })
  assert.equal(workflow.on.workflow_dispatch.inputs.runner_create_allowlist, undefined)
  assert.match(source, /environment: \$\{\{ inputs\.stage \}\}/)
  assert.equal(workflow.permissions['id-token'], 'write')
  assert.equal(workflow.jobs.deploy['runs-on'], 'ubuntu-24.04')

  // `if:` restricts the workflow ref, not the dispatched `ref` input — this shell guard is the
  // only thing binding the built commit to main or to a pull request someone is proposing. Read
  // the step it lives in, since demoting a line to a comment leaves it greppable while the guard
  // is gone.
  const refGuardStep = workflow.jobs['resolve-ref'].steps.find(
    (step) => step.name === 'Require a commit on main or an open pull request',
  )
  assert.ok(refGuardStep, 'the deployable-commit guard step is missing')
  // Anchored per line with no leading `#`: a parsed read still hands back the whole shell body,
  // so commenting a check out leaves it matchable while it no longer runs. `&&` is allowed
  // because the main test is the second half of an `if`, but `#` still is not.
  assert.match(refGuardStep.run, /^\s*(&& )?git merge-base --is-ancestor "\$candidate" origin\/main/m)
  assert.match(refGuardStep.run, /^\s*\[\[ "\$candidate" =~ \^\[0-9a-f\]\{40\}\$ \]\]/m)
  assert.match(refGuardStep.run, /^\s*set -euo pipefail/m)
  // The pull-request path is the widened surface, so pin all three things that keep it narrow:
  // only an OPEN pull request, only its head (/commits/{sha}/pulls also returns a PR's
  // intermediate commits, which no review is looking at), and only one opened from THIS
  // repository. The fork clause is the load-bearing one: build-c and build-runner check the
  // resolved commit out with contents: write, and the deploy job runs its npm ci / npm test after
  // the OIDC role is configured, so a fork head would be arbitrary code holding credentials.
  assert.match(
    refGuardStep.run,
    /^\s*--jq .*select\(\.state == \\"open\\" and \.head\.sha == \\"\$\{candidate\}\\" and \.head\.repo\.full_name == \\"\$\{GITHUB_REPOSITORY\}\\"\)/m,
  )
  // Neither path matching has to fail the job; a guard that falls through deploys an arbitrary SHA.
  assert.match(refGuardStep.run, /^\s*\[ -n "\$number" \] \|\| \{$/m)
  assert.match(refGuardStep.run, /is not on main, and not the head of an open pull request in/)
  // The API read the pull-request path depends on; without it the query 404s and every PR ref is
  // rejected, silently reverting this to main-only.
  assert.equal(workflow.jobs['resolve-ref'].permissions['pull-requests'], 'read')
  assert.equal(workflow.jobs['resolve-ref'].permissions.contents, 'read')

  // The reusable builds and what they are told to build: `with:` values decide which commit and
  // which C SDK the Runner links, and build-runner-binary.yml defaults libboxlite_source to the
  // published release, so an absent input silently links the wrong artifact.
  assert.equal(workflow.jobs['build-c'].uses, './.github/workflows/build-c.yml')
  assert.equal(workflow.jobs['build-c'].with.linux_x64_only, true)
  assert.equal(workflow.jobs['build-c'].with.ref, '${{ needs.resolve-ref.outputs.sha }}')
  assert.equal(workflow.jobs['build-runner'].uses, './.github/workflows/build-runner-binary.yml')
  assert.equal(workflow.jobs['build-runner'].with.libboxlite_source, 'artifact')
  assert.equal(workflow.jobs['build-runner'].with.ref, '${{ needs.resolve-ref.outputs.sha }}')
  assert.equal(workflow.jobs['build-api'].uses, './.github/workflows/build-apps-api-image.yml')
  assert.equal(workflow.jobs['build-api'].with.ref, '${{ needs.resolve-ref.outputs.sha }}')
  assert.equal(workflow.jobs['build-api'].with.stage, '${{ inputs.stage }}')

  // The Api leg links against nothing the C SDK produces. Adding build-c to its `needs` would
  // still deploy the right bytes, just serialized behind a Rust compile it never reads.
  assert.deepEqual(workflow.jobs['build-api'].needs, 'resolve-ref')

  // The suite that proves the deploy is the third call of that shape, and the two values that
  // make it worth running are just as much contract. Drop `with.ref` and it builds its SDKs from
  // tip-of-main against whatever commit was deployed; drop the apply gate and it spends dev-stack
  // capacity re-testing a stack the run only previewed.
  assert.equal(workflow.jobs.e2e.uses, './.github/workflows/e2e-cloud.yml')
  assert.equal(workflow.jobs.e2e.with.ref, '${{ needs.resolve-ref.outputs.sha }}')
  assert.equal(workflow.jobs.e2e.if, '${{ inputs.apply }}')
  // Named, not `inherit` — which would also hand the suite DEPLOY_ENV and the Cloudflare token.
  assert.equal(workflow.jobs.e2e.secrets.BOXLITE_DEV_API_KEY, '${{ secrets.BOXLITE_DEV_API_KEY }}')
  // `needs` carries the ordering the `if` relies on: no status-check function appears in that
  // expression, so the default success() is what stops the suite running behind a failed deploy.
  assert.deepEqual(workflow.jobs.e2e.needs, ['resolve-ref', 'deploy'])

  // Both components resolve to the one commit the build jobs actually produced. The stage secret
  // cannot redirect that: deploy-environment-validation.mjs rejects the selector keys outright.
  for (const selector of ['BOXLITE_ARTIFACT_SOURCE', 'API_ARTIFACT_SOURCE', 'RUNNER_ARTIFACT_SOURCE']) {
    assert.equal(workflow.jobs.deploy.env[selector], 'build', `${selector} must be set on the deploy job`)
  }
  assert.equal(workflow.jobs.deploy.env.BOXLITE_ARTIFACT_REF, '${{ needs.resolve-ref.outputs.sha }}')
  // Both build legs, not just the Runner's. Dropping build-api would let the deploy resolve a
  // commit image tag whose build had not finished — or never ran — and fail on the pull.
  assert.deepEqual(workflow.jobs.deploy.needs, ['resolve-ref', 'build-api', 'build-runner'])
  const versionStep = workflow.jobs.deploy.steps.find((step) => step.name === 'Resolve commit version')
  assert.ok(versionStep, 'the commit-version step is missing')
  assertShellLine(versionStep.run, /echo "VERSION=\$version" >> "\$GITHUB_ENV"/)

  // Staging decides over the ref, not per key: completing a half-published ref would pair a
  // freshly built (non-byte-identical) manifest with the already-stored tarball, and write-once
  // makes that unrepairable. runner-artifact-build.mjs refuses the same case locally.
  const stageStep = workflow.jobs.deploy.steps.find((step) => step.name === 'Stage commit Runner artifact')
  assert.ok(stageStep, 'the artifact staging step is missing')
  assertShellLine(stageStep.run, /if \[ "\$present" -eq 2 \]; then/)
  assertShellLine(stageStep.run, /elif \[ "\$present" -eq 1 \]; then/)
  assertShellLine(stageStep.run, /is partially published; delete the objects under it and rerun/)
  assertShellLine(stageStep.run, /--if-none-match '\*'/)
  const archStep = workflow.jobs.deploy.steps.find((step) => step.name === 'Verify native AMD64 Docker')
  assert.ok(archStep, 'the native-arch guard step is missing')
  assertShellLine(archStep.run, /test "\$\(uname -m\)" = "x86_64"/)
  assertShellLine(archStep.run, /test "\$\(docker info --format '\{\{\.Architecture\}\}'\)" = "x86_64"/)
  assert.match(source, /aws-actions\/configure-aws-credentials@/)
  assert.match(source, /role-to-assume: \$\{\{ vars\.AWS_DEPLOY_ROLE_ARN \}\}/)
  assert.match(source, /secrets\.DEPLOY_ENV/)
  assert.equal(workflow.jobs.deploy.env.RUNNER_CREATE_ALLOWLIST, undefined)
  // Every sst step passes --stage "$STAGE"; without this job env they would all
  // run with an empty stage.
  assert.equal(workflow.jobs.deploy.env.STAGE, '${{ inputs.stage }}')
  assert.equal(workflow.jobs.deploy.env.IAM_PERMISSIONS_BOUNDARY_STAGE, '${{ inputs.stage }}')
  assert.match(source, /node apps\/infra\/scripts\/deploy-environment-validation\.mjs apps\/infra\/\.env/)
  assert.doesNotMatch(materializeStep.run, /grep/)
  assert.ok(safetyTestStep, 'the deployment safety test step is missing')
  assert.equal(safetyTestStep.run, 'npm test')
  assert.ok(materializeStep, 'the stage configuration step is missing')
  const liveMaterialize = liveShell(materializeStep.run)
  const materializeConfigIndex = liveMaterialize.indexOf('printf \'%s\\n\' "$DEPLOY_ENV" > apps/infra/.env')
  const validateConfigIndex = liveMaterialize.indexOf(
    'node apps/infra/scripts/deploy-environment-validation.mjs apps/infra/.env',
  )
  assert.notEqual(materializeConfigIndex, -1, 'the stage configuration is not materialized')
  assert.ok(validateConfigIndex > materializeConfigIndex, 'DEPLOY_ENV must be validated after it is materialized')
  assert.ok(installStep, 'the SST provider installation step is missing')
  assert.equal(installStep.run, 'npm run --silent sst -- install --stage "$STAGE"')
  assert.ok(previewStep, 'the full-stack preview step is missing')
  assert.equal(previewStep.if, undefined, 'Preview validation must not be conditional')
  assert.equal(previewStep['continue-on-error'], undefined, 'Preview failures must stop deployment')
  assert.equal(previewStep.shell, 'bash')
  assert.equal(
    previewStep.run,
    [
      'set -euo pipefail',
      'npm run --silent sst -- diff --stage "$STAGE" --policy . --json |',
      '  node scripts/deployment-preview.mjs',
      '',
    ].join('\n'),
  )
  assert.ok(deployStep, 'the full-stack deployment step is missing')
  assert.equal(deployStep.if, '${{ inputs.apply }}')
  assert.equal(deployStep.run, 'npm run deploy -- --stage "$STAGE" --policy .')
  assert.ok(
    workflow.jobs.deploy.steps.indexOf(previewStep) < workflow.jobs.deploy.steps.indexOf(deployStep),
    'Preview validation must complete before deployment',
  )
  assert.ok(
    workflow.jobs.deploy.steps.indexOf(safetyTestStep) < workflow.jobs.deploy.steps.indexOf(previewStep),
    'Runner lifecycle contracts must be tested before the deployment preview',
  )
  assert.ok(boundaryCheckStep, 'the IAM boundary preflight step is missing')
  assert.ok(
    workflow.jobs.deploy.steps.indexOf(safetyTestStep) < workflow.jobs.deploy.steps.indexOf(boundaryCheckStep) &&
      workflow.jobs.deploy.steps.indexOf(boundaryCheckStep) < workflow.jobs.deploy.steps.indexOf(previewStep),
    'The IAM boundary preflight must run after safety tests and before the deployment preview',
  )
  assert.ok(
    workflow.jobs.deploy.steps.indexOf(materializeStep) < workflow.jobs.deploy.steps.indexOf(installStep) &&
      workflow.jobs.deploy.steps.indexOf(installStep) < workflow.jobs.deploy.steps.indexOf(previewStep),
    'SST providers must be installed after stage config and before the deployment preview',
  )
  assert.doesNotMatch(`${previewStep.run}\n${deployStep.run}`, /--(?:target|exclude)(?:[=\s]|$)/)
  assert.doesNotMatch(source, /setup-qemu/)
})

test('the checked-in deploy role satisfies the CI IAM boundary preflight', () => {
  // The preflight gates every deploy, so the template it inspects must actually
  // grant what it looks for. Reads the real ci/github-deploy-role.yaml rather
  // than a hand-copied fixture, so template drift fails here instead of wedging
  // CI on the next run.
  const template = load(readFileSync(DEV_DEPLOY_ROLE, 'utf8'), { schema: CLOUDFORMATION_SCHEMA })
  const accountId = '123456789012'
  const stage = 'dev'
  const policyDocuments = template.Resources.GitHubDeployRole.Properties.Policies.map((policy) => policy.PolicyDocument)

  // `!Ref BoxLiteRuntimePermissionsBoundary` yields that ManagedPolicy's ARN at
  // deploy time; the YAML parser leaves the logical id. Resolve it through the
  // resource's declared ManagedPolicyName so renaming the policy — which would
  // break the real grant — fails this test instead of passing vacuously.
  const boundaryPolicyName = template.Resources.BoxLiteRuntimePermissionsBoundary.Properties.ManagedPolicyName.replace(
    '${GitHubEnvironment}',
    stage,
  )
  const boundaryArn = `arn:aws:iam::${accountId}:policy/${boundaryPolicyName}`

  const resolved = JSON.parse(
    JSON.stringify(policyDocuments)
      .replaceAll('${AWS::Partition}', 'aws')
      .replaceAll('${AWS::AccountId}', accountId)
      .replaceAll('${GitHubEnvironment}', stage)
      .replaceAll('"BoxLiteRuntimePermissionsBoundary"', JSON.stringify(boundaryArn)),
  )

  const { grants } = verifyDeployRoleGrantsBoundaryPermission({
    callerArn: `arn:aws:sts::${accountId}:assumed-role/boxlite-${stage}-github-deploy/session`,
    accountId,
    stage,
    policyDocuments: resolved,
  })
  assert.equal(
    grants,
    true,
    'ci/github-deploy-role.yaml must grant iam:PutRolePermissionsBoundary for the stage boundary',
  )
})

test('the deploy role grants the CloudFront KeyValueStore prefix Router needs', () => {
  // `cloudfront:*` does not reach `cloudfront-keyvaluestore:*` — an IAM
  // wildcard never crosses the `service:` colon, and these are two service
  // prefixes. sst.aws.Router stores its route table in a KeyValueStore, so
  // without this grant every apply dies on DescribeKeyValueStore while every
  // preview passes, because a preview makes no KV call.
  const template = load(readFileSync(DEV_DEPLOY_ROLE, 'utf8'), { schema: CLOUDFORMATION_SCHEMA })
  const actions = template.Resources.GitHubDeployRole.Properties.Policies.flatMap((policy) =>
    policy.PolicyDocument.Statement.flatMap((statement) =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action],
    ),
  )
  assert.ok(
    actions.includes('cloudfront-keyvaluestore:*'),
    'ci/github-deploy-role.yaml must grant cloudfront-keyvaluestore:*; cloudfront:* does not cover it',
  )
})

test('package scripts disable long-running SST dev for the stateful stack', () => {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'apps/infra/package.json'), 'utf8'))

  assert.equal(packageJson.scripts.dev, undefined)
})

test('commit Runner builds consume the C SDK artifact from the same reusable run', () => {
  const cSource = readFileSync(BUILD_C_WORKFLOW, 'utf8')
  const runnerSource = readFileSync(BUILD_RUNNER_WORKFLOW, 'utf8')
  const cWorkflow = load(cSource)
  const runnerWorkflow = load(runnerSource)

  // deploy-infra.yml calls both by `uses:`, so the reusable entrypoint and the inputs it passes
  // are contract, not prose. Read them off the parsed trigger — a commented-out `workflow_call:`
  // still satisfies a substring match while making every caller dead.
  assert.ok(cWorkflow.on.workflow_call, 'build-c.yml is no longer callable as a reusable workflow')
  assert.ok(cWorkflow.on.workflow_call.inputs.linux_x64_only, 'build-c.yml dropped the linux_x64_only input')
  assert.ok(cWorkflow.on.workflow_call.inputs.ref, 'build-c.yml dropped the ref input')
  assert.ok(runnerWorkflow.on.workflow_call, 'build-runner-binary.yml is no longer callable')
  assert.ok(runnerWorkflow.on.workflow_call.inputs.libboxlite_source, 'the C SDK source input is gone')
  assert.ok(runnerWorkflow.on.workflow_call.inputs.ref, 'build-runner-binary.yml dropped the ref input')

  // The upload/download names are the handshake between the two runs: build-c publishes
  // c-sdk-<target>, build-runner consumes c-sdk-linux-x64-gnu. Compare parsed values so a legal
  // requoting does not fail and a commented-out `name:` does not pass.
  const uploadName = (workflow, jobName) =>
    Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .find((step) => typeof step.uses === 'string' && step.uses.startsWith(jobName))?.with?.name
  assert.equal(uploadName(cWorkflow, 'actions/upload-artifact'), 'c-sdk-${{ matrix.target }}')
  assert.equal(uploadName(runnerWorkflow, 'actions/download-artifact'), 'c-sdk-linux-x64-gnu')
  // Scope to the `artifact)` case arm, not the file or even the step: build-runner-binary.yml
  // branches on libboxlite_source, and both arms set identity/archive — so a wider match still
  // passes when the commit-keyed names are moved under the `release)` label.
  const runnerStepRun = (name) =>
    Object.values(runnerWorkflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .find((step) => step.name === name)?.run
  const identityRun = runnerStepRun('Resolve artifact identity')
  assert.ok(identityRun, 'the artifact-identity step is missing')
  const commitArm =
    liveShell(identityRun)
      .split(/^\s*artifact\)\s*$/m)[1]
      ?.split(';;')[0] ?? ''
  assert.ok(commitArm, 'the commit-build case arm is missing')
  assert.match(commitArm, /identity="\$\{VERSION\}\+\$\{BUILD_SHA\}"/)
  assert.match(commitArm, /archive="boxlite-runner-v\$\{VERSION\}-\$\{BUILD_SHA\}-linux-amd64\.tar\.gz"/)
  assertShellLine(
    runnerStepRun('Build runner'),
    /github\.com\/boxlite-ai\/runner\/internal\.Version=\$\{VERSION_IDENTITY\}/,
  )

  // The extracted library is addressed, not hunted for. Searching /tmp walks root-owned siblings
  // (snap-private-tmp, systemd-private-*); find then reports those permission errors in its exit
  // status even when it matched, and `set -e` failed the step with the library already on disk.
  // build-c.yml packages one top-level directory named after the archive, which is the same
  // assumption the `release` branch of this step has always made.
  const extractRun = runnerStepRun('Extract commit libboxlite.a')
  assert.ok(extractRun, 'the commit libboxlite.a extraction step is missing')
  assertShellLine(extractRun, /cp "\/tmp\/\$\(basename "\$archive" \.tar\.gz\)\/lib\/libboxlite\.a" sdks\/go\/libboxlite\.a/)
  assert.doesNotMatch(liveShell(extractRun), /find \/tmp\b(?!\/c-sdk)/, 'the library must not be searched for under /tmp')
})

test('the cloud E2E suite is reachable only from a deploy or a human', () => {
  const workflow = load(readFileSync(E2E_CLOUD_WORKFLOW, 'utf8'))

  // The whole point of the trigger surface: this job builds and runs the tree in the same job
  // that holds a live dev API key, so no event may reach it that an outsider can raise. Compare
  // the parsed trigger keys as a set rather than asserting the two we want are present — the
  // failure to catch is a *re-added* `pull_request_target`, which every presence check passes.
  assert.deepEqual(Object.keys(workflow.on).sort(), ['workflow_call', 'workflow_dispatch'])

  // Read the callee's own declarations: a commented-out `workflow_call:` still satisfies a
  // substring match while making deploy-infra's call dead.
  assert.ok(workflow.on.workflow_call, 'e2e-cloud.yml is no longer callable as a reusable workflow')
  assert.equal(workflow.on.workflow_call.inputs.ref.required, true)
  assert.equal(workflow.on.workflow_call.secrets.BOXLITE_DEV_API_KEY.required, true)

  // A callee inherits the caller's token and may only narrow it, so this line — not anything in
  // deploy-infra.yml — is what keeps `id-token: write`, the deploy role's entry, away from a job
  // that executes the checked-out tree.
  assert.equal(workflow.permissions?.contents, 'read')
  assert.equal(workflow.permissions?.['id-token'], undefined)

  // The checkout has to follow the caller's commit. Falling back to github.sha alone would test
  // the tip of whatever ref the *caller* ran from, which for a re-deploy of an older commit is
  // not the commit now on the stack.
  const checkout = workflow.jobs.e2e.steps.find(
    (step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout'),
  )
  assert.ok(checkout, 'the e2e job no longer checks out a ref')
  assert.equal(checkout.with.ref, '${{ inputs.ref || github.sha }}')
})

test('release deployment consumes one published version for both components', () => {
  const source = readFileSync(RELEASE_DEPLOY_WORKFLOW, 'utf8')
  const workflow = load(source)
  const deployStep = workflow.jobs.deploy.steps.find(
    (step) => step.name === 'Deploy published API and Runner artifacts',
  )

  // Read the parsed job env, not the file: these three must be on the *job* for the deploy step
  // to inherit them. Moved onto any single step they still match a substring search, while the
  // deploy silently falls back to COMPONENT_DEFAULT_KINDS and rebuilds the API from the checkout.
  for (const selector of ['BOXLITE_ARTIFACT_SOURCE', 'API_ARTIFACT_SOURCE', 'RUNNER_ARTIFACT_SOURCE']) {
    assert.equal(workflow.jobs.deploy.env[selector], 'release', `${selector} must be set on the deploy job`)
  }
  // Off unless asked for: the API has no downgrade guard, so an older VERSION deployed without
  // this moves the API back while the Runner refuses, and the workflow still reports success.
  // The unanchored source match would have accepted `default: true` plus any later false.
  assert.equal(workflow.on.workflow_dispatch.inputs.allow_downgrade.default, false)
  assert.equal(workflow.on.workflow_dispatch.inputs.allow_downgrade.type, 'boolean')
  // These two carry the inputs into the deploy job; commented out, the defaults above become
  // decoration. Read the parsed job env rather than the file.
  assert.equal(workflow.jobs.deploy.env.ALLOW_DOWNGRADE, "${{ inputs.allow_downgrade && '1' || '' }}")
  assert.equal(workflow.jobs.deploy.env.VERSION, '${{ inputs.version }}')
  assert.match(source, /environment: \$\{\{ inputs\.stage \}\}/)
  // `stage` picks the protected Environment holding the AWS role, so it must be untypable
  // rather than merely wrong — the same allowlist rule deploy-infra.yml follows.
  assert.equal(workflow.on.workflow_dispatch.inputs.stage.type, 'choice')
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.stage.options, ['dev', 'prod'])
  assert.ok(deployStep)
  // The same guarded wrapper and the same pre-deploy gates the build path uses: a release
  // deploy reconciles the identical stack, so it owes the identical safety checks.
  assert.equal(deployStep.run, 'npm run deploy -- --stage "$STAGE" --policy .')
  assert.ok(workflow.jobs.deploy.steps.find((step) => step.name === 'Run deployment safety tests'))
  const boundaryStep = workflow.jobs.deploy.steps.find(
    (step) => step.name === 'Verify deploy role IAM boundary permissions',
  )
  assert.ok(boundaryStep, 'the release deploy skips the IAM boundary preflight')
  assert.ok(
    workflow.jobs.deploy.steps.indexOf(boundaryStep) < workflow.jobs.deploy.steps.indexOf(deployStep),
    'the boundary preflight must run before the deploy it protects',
  )
})

test('the deployment workflows cap the token they hand their jobs', () => {
  // CodeQL actions/missing-workflow-permissions: without a top-level block a job inherits the
  // repository default, which can be write. Scoped to the workflows this change owns — ten
  // others in the directory predate it and are not this commit's to re-scope.
  for (const entry of [
    'build-apps-api-image.yml',
    'build-c.yml',
    'build-runner-binary.yml',
    'deploy-infra.yml',
    'deploy-release.yml',
    // The deploy path's third reusable callee. Its cap does more work than the others': it is
    // what narrows the inherited deploy token, so it belongs under the same guard.
    'e2e-cloud.yml',
  ]) {
    const workflow = load(readFileSync(join(REPO_ROOT, '.github/workflows', entry), 'utf8'))
    assert.equal(workflow.permissions?.contents, 'read', `${entry} must default its token to contents: read`)

    // A job may raise its own, but only deliberately, and only the scope it has a reason for —
    // by scope rather than by job, so a job that already has one reason to raise cannot pick up
    // an unrelated second one unnoticed:
    //   upload-to-release — actually writes (uploads release assets)
    //   build-c / build-runner — write nothing; they call a workflow whose release-upload job
    //     declares contents: write (see the caller-grant test below). Granting per job rather
    //     than at the top keeps `deploy` at contents: read.
    //   build-api — calls a workflow that assumes an AWS role through OIDC. A job-level block
    //     replaces the workflow-level one, so it restates id-token rather than inheriting it.
    const expectedWriters = {
      'upload-to-release': ['contents'],
      'build-c': ['contents'],
      'build-runner': ['contents'],
      'build-api': ['id-token'],
    }
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      if (!job.permissions) continue
      const raised = Object.entries(job.permissions)
        .filter(([, level]) => level === 'write')
        .map(([scope]) => scope)
      const allowed = expectedWriters[jobName] ?? []
      const unexpected = raised.filter((scope) => !allowed.includes(scope))
      assert.deepEqual(unexpected, [], `${entry} job '${jobName}' raises ${JSON.stringify(unexpected)} without a reason`)
    }
  }
})

test('a job calling a reusable workflow grants at least what that workflow asks for', () => {
  // Documented: "permissions can only be maintained or reduced—not elevated—throughout the
  // chain" — https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows
  //
  // Measured: dispatching deploy-infra at 32cfa5c3, where the build-c job granted less than
  // build-c.yml asks for, produced a startup_failure with zero jobs, zero logs and zero
  // annotations — GitHub said only "a workflow file issue". actionlint exits 0 on that file.
  //
  // Inferred: that the elevation is what rejected the run. The docs describe the ceiling, not
  // what happens when a callee asks past it, and GitHub never named a cause. If a dispatch
  // shows the callee simply running with a reduced token instead, revisit this comment.
  const directory = join(REPO_ROOT, '.github/workflows')
  const LOCAL = './.github/workflows/'
  const RANK = { none: 0, read: 1, write: 2 }
  const readWorkflow = (file) => load(readFileSync(join(directory, file), 'utf8'))

  // The widest permission any job in the callee asks for, following nested calls.
  const required = (file, seen = new Set()) => {
    if (seen.has(file)) return {}
    seen.add(file)
    const workflow = readWorkflow(file)
    const widest = {}
    const merge = (permissions) => {
      if (!permissions || typeof permissions !== 'object') return
      for (const [scope, level] of Object.entries(permissions)) {
        if ((RANK[level] ?? 0) > (RANK[widest[scope]] ?? 0)) widest[scope] = level
      }
    }
    merge(workflow.permissions)
    for (const job of Object.values(workflow.jobs ?? {})) {
      merge(job.permissions)
      if (typeof job.uses === 'string' && job.uses.startsWith(LOCAL)) {
        merge(required(job.uses.slice(LOCAL.length), seen))
      }
    }
    return widest
  }

  let checked = 0
  for (const entry of readdirSync(directory).filter((file) => /\.ya?ml$/.test(file))) {
    const workflow = readWorkflow(entry)
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      if (typeof job.uses !== 'string' || !job.uses.startsWith(LOCAL)) continue
      // A job-level block replaces the workflow-level one rather than merging with it.
      const granted = job.permissions ?? workflow.permissions ?? {}
      for (const [scope, level] of Object.entries(required(job.uses.slice(LOCAL.length)))) {
        assert.ok(
          (RANK[granted[scope]] ?? 0) >= (RANK[level] ?? 0),
          `${entry} job '${jobName}' grants ${scope}: ${granted[scope] ?? 'none'} but ` +
            `${job.uses.slice(LOCAL.length)} needs ${level}`,
        )
      }
      checked += 1
    }
  }
  assert.ok(checked >= 11, `expected every local reusable call to be swept, saw ${checked}`)
})

test('every workflow that selects a deployment Environment does so from an allowlist', () => {
  // The rule is stated once in .github/workflows/README.md and enforced here across every
  // workflow file, so a fourth deploy workflow cannot quietly reintroduce a free-text stage that
  // reaches a required-reviewers Environment through a typo. Read `environment` off the parsed
  // job rather than matching source text: GitHub accepts both the bare string and the
  // `{ name, url }` object, and the object form is what you write to surface a deployment URL —
  // so a text matcher would miss exactly the workflows most likely to use it.
  const workflowDirectory = join(REPO_ROOT, '.github/workflows')
  const environmentInput = /^\$\{\{\s*(?:github\.event\.)?inputs\.([A-Za-z_][A-Za-z0-9_-]*)\s*(?:\|\||\}\})/
  const swept = new Set()

  for (const entry of readdirSync(workflowDirectory)) {
    if (!/\.ya?ml$/.test(entry)) continue
    const workflow = load(readFileSync(join(workflowDirectory, entry), 'utf8'))
    const inputs = workflow.on?.workflow_dispatch?.inputs ?? {}

    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      const environment = typeof job.environment === 'string' ? job.environment : job.environment?.name
      if (!environment) continue
      const where = `${entry} job '${jobName}'`

      // Fail closed on any indirection. `needs.*.outputs.*`, `env.*`, and `vars.*` all reach an
      // Environment through a value this test cannot follow, so requiring the direct input is
      // the only form that stays checkable — an indirect one must be made explicit here first.
      const selected = environment.match(environmentInput)
      assert.ok(
        selected || !environment.includes('${{'),
        `${where} selects an Environment through an expression this guard cannot follow: ${environment}`,
      )
      if (selected) {
        const declared = inputs[selected[1]]
        assert.ok(declared, `${where} selects an Environment from an undeclared input '${selected[1]}'`)
        assert.equal(declared.type, 'choice', `${where} input '${selected[1]}' must be an allowlist`)
        assert.ok(declared.options?.length > 0, `${where} input '${selected[1]}' has an empty allowlist`)
      }

      // The same job that reaches a protected Environment reaches the AWS role behind it, so
      // the main-only rule is asserted here rather than as a bare substring per workflow.
      assert.match(job.if ?? '', /github\.ref == 'refs\/heads\/main'/, `${where} is not restricted to main`)
      swept.add(entry)
    }
  }

  assert.deepEqual(
    [...swept].sort(),
    ['build-apps-api-image.yml', 'deploy-infra.yml', 'deploy-release.yml'],
    'the swept set no longer matches the deployment workflows',
  )
})

test('API publishing builds once and promotes that exact image without rebuilding', () => {
  const source = readFileSync(API_IMAGE_BUILD_WORKFLOW, 'utf8')
  const workflow = load(source)

  for (const input of ['stage', 'source_stage']) {
    assert.equal(workflow.on.workflow_dispatch.inputs[input].type, 'choice', `${input} must be an allowlist`)
    assert.deepEqual(workflow.on.workflow_dispatch.inputs[input].options, ['dev', 'prod'])
  }

  // A release event runs on a tag ref, which the branch-scoped deployment Environments block
  // before the job can reach its AWS role — so publishing is dispatched from main instead.
  // Read the parsed trigger: `on:` and `"on":` are the same key, and only one is greppable.
  assert.equal(workflow.on.release, undefined, 'publishing must not trigger on a release event')
  assert.deepEqual(Object.keys(workflow.on), ['workflow_call', 'workflow_dispatch'])

  // Commit mode: how deploy-infra.yml builds the Api for the commit it deploys. `ref` is what
  // selects it, so it has to be call-only — a dispatch that could set it would let someone tag an
  // image for a commit the deployable-commit guard never saw.
  assert.deepEqual(Object.keys(workflow.on.workflow_call.inputs).sort(), ['ref', 'stage'])
  assert.equal(workflow.on.workflow_dispatch.inputs.ref, undefined)
  assert.equal(workflow.on.workflow_call.inputs.ref.required, true)
  assert.equal(workflow.on.workflow_call.inputs.stage.required, true)
  const commitCheckout = workflow.jobs.publish.steps.find((step) => step.name === 'Checkout the selected commit')
  assert.ok(commitCheckout, 'the commit checkout step is missing')
  assert.equal(commitCheckout.with.ref, '${{ inputs.ref }}')
  // The build must compile the release tag, not whatever main points at now — read it off the
  // parsed step, since a commented-out `ref:` still satisfies a substring match.
  const releaseCheckout = workflow.jobs.publish.steps.find((step) => step.name === 'Checkout the released tag')
  assert.ok(releaseCheckout, 'the released-tag checkout step is missing')
  assert.equal(releaseCheckout.with.ref, 'refs/tags/v${{ inputs.version }}')
  // This workflow compiles the released image, so it owes the same native-arch guard the deploy
  // path has — a second copy of the step means pinning it in deploy-infra.yml says nothing here.
  const publishArch = workflow.jobs.publish.steps.find((step) => step.name === 'Verify native AMD64 Docker')
  assert.ok(publishArch, 'the native-arch guard step is missing')
  assertShellLine(publishArch.run, /test "\$\(uname -m\)" = "x86_64"/)
  assertShellLine(publishArch.run, /test "\$\(docker info --format '\{\{\.Architecture\}\}'\)" = "x86_64"/)

  const resolveRun = workflow.jobs.publish.steps.find((step) => step.name === 'Resolve publish operation')?.run ?? ''
  assertShellLine(resolveRun, /tag v\$version declares Cargo\.toml version/)
  assertShellLine(resolveRun, /builds always land in dev/)
  // The one string the deploy has to agree with. apiImageTag() in api-artifact.mjs derives the
  // reference SST is handed; if these two drift the deploy resolves a tag nothing ever pushed and
  // only finds out when the ECS task fails to pull. api-artifact.test.mjs pins the other half.
  assertShellLine(resolveRun, /tag="v\$\{version\}-\$\{INPUT_REF\}"/)
  // A ref that is not a full lowercase sha would tag an image nobody can address again.
  assertShellLine(resolveRun, /\[\[ "\$INPUT_REF" =~ \^\[0-9a-f\]\{40\}\$ \]\]/)
  // "builds once and promotes that exact image" is a property of *which step* compiles. Matched
  // against the whole file, moving `docker build` into the promote step reads as unchanged.
  const stepRun = (name) => workflow.jobs.publish.steps.find((step) => step.name === name)?.run ?? ''
  const buildRun = stepRun('Build the image once')
  const promoteRun = stepRun('Promote the exact published image')
  assertShellLine(buildRun, /docker build --file apps\/api\/Dockerfile/)
  // A registry-side manifest copy, not a daemon round-trip: pull + tag + push re-uploads the
  // image and can change its digest, which is exactly what "promotes that exact image" denies.
  // By digest, not by tag: the source tag can move between the check above and this copy, and a
  // comparison afterwards would only notice once the wrong image was already published.
  assertShellLine(promoteRun, /docker buildx imagetools create --prefer-index=false/)
  assertShellLine(promoteRun, /--tag "\$TARGET:\$TAG" "\$SOURCE@\$SOURCE_DIGEST"/)
  // Over the live shell: the comment above the copy names the `docker build`/`docker push` pair
  // it exists to explain, and a mention in a comment is not a rebuild. Both intervening tokens
  // are spelled out rather than excluded by a trailing space — the step already invokes `docker
  // buildx`, and `docker image push|tag` is the management-command form of the same verbs, so
  // either is a plausible way a rebuild returns. `imagetools create` stays exempt because it is
  // none of build/pull/push/tag (and `\b` keeps `build` from matching inside `buildx`).
  assert.doesNotMatch(
    liveShell(promoteRun),
    /docker (?:buildx |image )?(?:build|pull|push|tag)\b/,
    'promotion must copy, never rebuild or re-upload',
  )
  // And it proves preservation rather than assuming it.
  assertShellLine(promoteRun, /if \[ "\$promoted" != "\$SOURCE_DIGEST" \]; then/)
})

test('infrastructure tests cannot persist or write with the workflow token', () => {
  const source = readFileSync(LINT_WORKFLOW, 'utf8')
  const infraJobStart = source.indexOf('\n  infra:\n')
  const infraJobEnd = source.indexOf('  # Single required status check', infraJobStart)
  assert.notEqual(infraJobStart, -1, 'infra job marker is missing from lint.yml')
  assert.notEqual(infraJobEnd, -1, 'required-status marker is missing from lint.yml')
  const infraJob = source.slice(infraJobStart, infraJobEnd)

  assert.match(infraJob, /permissions:\s+contents: read/)
  assert.match(infraJob, /uses: actions\/checkout@v5\s+with:\s+persist-credentials: false/)
})

test('dev deploy role trusts only the repository GitHub Environment identity', () => {
  assert.ok(existsSync(DEV_DEPLOY_ROLE), 'the GitHub deployment role template is missing')
  const source = readFileSync(DEV_DEPLOY_ROLE, 'utf8')
  const statements = readRuntimeBoundaryStatements()

  assert.match(source, /oidc-provider\/token\.actions\.githubusercontent\.com/)
  assert.match(source, /token\.actions\.githubusercontent\.com:aud: sts\.amazonaws\.com/)
  assert.match(
    source,
    /token\.actions\.githubusercontent\.com:sub: !Sub repo:\$\{GitHubRepository\}:environment:\$\{GitHubEnvironment\}/,
  )
  assert.doesNotMatch(source, /AdministratorAccess/)
  assert.match(source, /BoxLiteRuntimePermissionsBoundary:/)
  assert.match(source, /iam:PermissionsBoundary/)
  assert.match(source, /PolicyName: boxlite-sst-deploy/)

  assert.deepEqual(findStatement(statements, 'BoxLiteStageSecrets'), {
    Sid: 'BoxLiteStageSecrets',
    Effect: 'Allow',
    Action: ['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue'],
    Resource:
      'arn:${AWS::Partition}:secretsmanager:${AWS::Region}:${AWS::AccountId}:secret:boxlite-${GitHubEnvironment}-*',
  })
  assert.deepEqual(findStatement(statements, 'BoxLiteStageKmsKeys'), {
    Sid: 'BoxLiteStageKmsKeys',
    Effect: 'Allow',
    Action: 'kms:Decrypt',
    Resource: 'arn:${AWS::Partition}:kms:${AWS::Region}:${AWS::AccountId}:key/*',
    Condition: {
      'ForAnyValue:StringLike': {
        'kms:ResourceAliases': 'alias/boxlite-${GitHubEnvironment}-*',
      },
    },
  })
  assert.deepEqual(findStatement(statements, 'BoxLiteBuckets'), {
    Sid: 'BoxLiteBuckets',
    Effect: 'Allow',
    Action: [
      's3:CreateBucket',
      's3:DeleteBucket',
      's3:GetBucketLocation',
      's3:ListBucket',
      's3:ListBucketVersions',
      's3:PutBucketTagging',
    ],
    Resource: [
      'arn:${AWS::Partition}:s3:::boxlite-${GitHubEnvironment}-*',
      'arn:${AWS::Partition}:s3:::boxlite-app-${GitHubEnvironment}-*',
      'arn:${AWS::Partition}:s3:::boxlite-volume-*',
    ],
  })
  assert.deepEqual(findStatement(statements, 'BoxLiteBucketObjects'), {
    Sid: 'BoxLiteBucketObjects',
    Effect: 'Allow',
    Action: ['s3:AbortMultipartUpload', 's3:DeleteObject', 's3:DeleteObjectVersion', 's3:GetObject', 's3:PutObject'],
    Resource: [
      'arn:${AWS::Partition}:s3:::boxlite-${GitHubEnvironment}-*/*',
      'arn:${AWS::Partition}:s3:::boxlite-app-${GitHubEnvironment}-*/*',
      'arn:${AWS::Partition}:s3:::boxlite-volume-*/*',
    ],
  })
})

test('the stage bootstrap owns artifact stores needed before an SST deploy can start', () => {
  const template = readDeployTemplate()
  const resources = template.Resources

  assert.deepEqual(template.Parameters.GitHubEnvironment, {
    Type: 'String',
    Default: 'dev',
    MinLength: 1,
    MaxLength: 32,
    AllowedPattern: '^[a-z0-9][a-z0-9-]*$',
  })
  assert.deepEqual(resources.ApiImagesRepository, {
    Type: 'AWS::ECR::Repository',
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: {
      RepositoryName: 'boxlite-app-${GitHubEnvironment}-api',
      ImageTagMutability: 'IMMUTABLE',
      ImageScanningConfiguration: { ScanOnPush: true },
      EncryptionConfiguration: { EncryptionType: 'AES256' },
    },
  })
  assert.deepEqual(resources.RunnerArtifactsBucket, {
    Type: 'AWS::S3::Bucket',
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: {
      BucketName: 'boxlite-app-${GitHubEnvironment}-artifacts-${AWS::AccountId}',
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      LifecycleConfiguration: {
        Rules: [
          {
            Id: 'expire-superseded-runner-builds',
            Prefix: 'runner/',
            Status: 'Enabled',
            NoncurrentVersionExpiration: { NoncurrentDays: 30 },
          },
        ],
      },
    },
  })
})

test('one release selector resolves the API and Runner to the same published version', () => {
  const source = readFileSync(SST_WRAPPER, 'utf8')

  assert.match(source, /const workspaceVersion = readWorkspaceVersion\(\)/)
  assert.match(source, /resolvePublicDeploymentConfig\(process\.env, workspaceVersion\)/)
  // resolveArtifactSource uses the same resolveReleaseVersion(workspace, env) contract as the
  // public deployment config. VERSION therefore selects both artifacts instead of producing an
  // API/Runner split-brain release.
  assert.match(source, /const runnerSource = resolveArtifactSource\('runner'\)/)
  assert.match(source, /await verifyRunnerArtifact\(runnerSource/)
  assert.doesNotMatch(source, /verifyRunnerReleaseAssets\(publicDeploymentConfig\.releaseVersion\)/)
})

test('every hand-written spelling of an artifact name agrees with the composer', () => {
  // The defect this guards: the name is declared in CloudFormation, resolved in JS, and written
  // by hand in the workflow that produces the artifact. Renaming the first two and not the last
  // two leaves a bootstrap that creates boxlite-app-dev-api and a build that pushes to
  // boxlite-dev-api — the workflow's own "repository is missing" guard fires and the deploy
  // fails, with every unit test still green. CloudFormation and bash cannot import
  // awsResourceName, so agreement is asserted here instead.
  const template = readDeployTemplate()
  const apiWorkflow = readFileSync(API_IMAGE_BUILD_WORKFLOW, 'utf8')
  const deployWorkflow = readFileSync(DEPLOY_WORKFLOW, 'utf8')

  const declaredRepository = template.Resources.ApiImagesRepository.Properties.RepositoryName
  const declaredBucket = template.Resources.RunnerArtifactsBucket.Properties.BucketName
  assert.equal(declaredRepository, 'boxlite-app-${GitHubEnvironment}-api')
  assert.equal(declaredBucket, 'boxlite-app-${GitHubEnvironment}-artifacts-${AWS::AccountId}')

  // Resolved: the same grammar, through the composer the deploy actually calls.
  assert.equal(apiImageRepository({ app: 'boxlite', stage: 'dev' }), 'boxlite-app-dev-api')
  assert.equal(
    runnerArtifactsBucketName({ app: 'boxlite', stage: 'dev', accountId: '123456789012' }),
    'boxlite-app-dev-artifacts-123456789012',
  )

  // Written by hand, in the two producers. Anchored per line so a commented-out spelling cannot
  // satisfy the match, and the old shape is refused outright rather than merely not found.
  assertShellLine(apiWorkflow, /boxlite-app-\$\{TARGET_STAGE\}-api/)
  assertShellLine(apiWorkflow, /boxlite-app-\$\{SOURCE_STAGE\}-api/)
  assertShellLine(deployWorkflow, /bucket="boxlite-app-\$\{STAGE\}-artifacts-\$\{account_id\}"/)
  assert.doesNotMatch(liveShell(apiWorkflow), /boxlite-\$\{(TARGET|SOURCE)_STAGE\}-api/)
  assert.doesNotMatch(liveShell(deployWorkflow), /boxlite-\$\{STAGE\}-artifacts/)
})

test('the runtime boundary admits the bucket the Runner is actually pointed at', () => {
  // The boundary intersects with every identity policy SST writes, so a bucket outside its
  // prefixes is denied however generous the grant. Renaming the bucket without widening the
  // boundary denied the Runner its own binary — at boot and on every SSM upgrade — while every
  // other test stayed green, because CI pushes with the deploy role's s3:* rather than the
  // instance profile. Derive the name, do not spell it.
  const bucket = runnerArtifactsBucketName({ app: 'boxlite', stage: 'dev', accountId: '123456789012' })
  const prefixes = findStatement(readRuntimeBoundaryStatements(), 'BoxLiteBucketObjects').Resource.map((arn) =>
    arn.replace('arn:${AWS::Partition}:s3:::', '').replace('${GitHubEnvironment}', 'dev'),
  )
  const admits = prefixes.some((pattern) => new RegExp(`^${pattern.replace(/\*/g, '.*')}$`).test(`${bucket}/runner/x`))
  assert.ok(admits, `no BoxLiteBucketObjects prefix admits ${bucket}/runner/*; prefixes: ${prefixes.join(', ')}`)
})
