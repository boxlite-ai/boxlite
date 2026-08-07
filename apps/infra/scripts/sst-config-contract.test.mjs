// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { liveText } from './live-source.mjs'

const source = readFileSync(new URL('../sst.config.ts', import.meta.url), 'utf8')
const environmentExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

// Every assertion over sst.config.ts in this file pins behavior, so the decision to strip both
// comment syntaxes is made here, once, rather than at each call site — a call site that reaches
// for the weaker stripper (or none) gets a guard that keeps passing over commented-out code.
// Markers are located in the raw text because several of them are themselves comments. A very
// few assertions read `source` on purpose, where what they pin IS a comment; each says so.
const configSection = (startMarker, endMarker) =>
  liveText('scriptEmittingShell', extractSection(source, startMarker, endMarker))
const liveConfig = liveText('scriptEmittingShell', source)

function extractSection(contents, startMarker, endMarker) {
  const start = contents.indexOf(startMarker)
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`)
  if (endMarker === undefined) return contents.slice(start)

  const end = contents.indexOf(endMarker, start + startMarker.length)
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`)
  assert.ok(end > start, `end marker must follow start marker: ${endMarker}`)
  return contents.slice(start, end)
}

test('loads local helpers dynamically inside SST config callbacks', () => {
  assert.doesNotMatch(liveConfig, /^import\s/m)
  assert.match(liveConfig, /async app\(input\)/)
  assert.match(liveConfig, /await import\('\.\/scripts\/deployment-environment\.mjs'\)/)
})

test('does not force a laptop-managed remote builder', () => {
  const appSource = configSection('async app(input)', 'async run()')

  assert.doesNotMatch(appSource, /buildx-builder/)
  assert.doesNotMatch(appSource, /BUILDX_BUILDER/)
  assert.doesNotMatch(environmentExample, /^BUILDX_BUILDER_/m)
})

test('pins the AWS provider used by the deployed stack', () => {
  assert.match(liveConfig, /aws:\s*\{\s*version: '7\.24\.0',\s*region: REGION,/)
})

test('applies the deployment permissions boundary to every SST-created IAM role', () => {
  assert.match(liveConfig, /const runtimePermissionsBoundaryArn =/)
  assert.match(liveConfig, /requireIamPermissionsBoundaryStage\(\$app\.stage\)/)
  assert.match(environmentExample, /^IAM_PERMISSIONS_BOUNDARY_STAGE=dev$/m)
  // The sole mechanism applying the boundary to every SST-created role, so it is read live:
  // commented out, the deploy still runs and every role it creates is unbounded.
  assert.match(
    liveConfig,
    /\$transform\(aws\.iam\.Role,[\s\S]*args\.permissionsBoundary \?\?= runtimePermissionsBoundaryArn/,
  )
})

test('uses the shared AWS region resolver and waits for the critical API service', () => {
  assert.match(
    liveConfig,
    /const \{[^}]*resolveAwsRegion[^}]*\} = await import\('\.\/scripts\/deployment-environment\.mjs'\)/,
  )
  assert.match(liveConfig, /const REGION = resolveAwsRegion\(\)/)

  const apiService = configSection("const api = new sst.aws.Service('Api'", '// Assumed by the Api task role')
  assert.match(apiService, /wait: true,/)
})

test('uses the canonical deployment config for every Proxy-facing SST value', () => {
  const runSource = configSection('async run()', '// ── runner bootstrap')

  assert.match(runSource, /resolvePublicDeploymentConfig/)
  assert.match(runSource, /const deploymentConfig = resolvePublicDeploymentConfig\(process\.env, workspaceVersion\)/)
  assert.match(runSource, /const \{ stackDomain, proxyDomain, proxyProtocol, proxyTemplateUrl, releaseVersion \}/)
  assert.doesNotMatch(runSource, /envOr\('PROXY_(?:DOMAIN|PROTOCOL|TEMPLATE_URL)'/)
})

test('keeps the AWS region in run scope and passes it into Runner user data', () => {
  const runSource = configSection('async run()', '// ── runner bootstrap')
  const runnerUserDataSource = configSection('async function buildRunnerUserData')

  assert.match(runSource, /const REGION = resolveAwsRegion\(\)/)
  assert.equal(runSource.match(/awsRegion: REGION/g)?.length, 2)
  assert.match(runnerUserDataSource, /awsRegion: string/)
  assert.match(runnerUserDataSource, /Environment=AWS_REGION=\$\{input\.awsRegion\}/)
})

test('tags Runner instances with their exact control-plane identity', () => {
  const runnerResources = configSection('const makeRunner =', '// Register the extra runners')

  assert.match(liveConfig, /import\('\.\/scripts\/runner-inventory\.cjs'\)/)
  assert.match(liveConfig, /const runnerInventory = resolveRunnerInventory\(process\.env\)/)
  assert.match(runnerResources, /'boxlite:control-plane-runner-name': controlPlaneRunnerName/)
  assert.match(
    runnerResources,
    /makeRunner\([\s\S]*defaultRunnerConfig\.resourceName,[\s\S]*defaultRunnerConfig\.nameTag,[\s\S]*defaultRunnerConfig\.controlPlaneRunnerName,[\s\S]*runnerUserData/,
  )
  assert.match(runnerResources, /runnerInventory\.slice\(1\)\.map\([\s\S]*runner\.nameTag,[\s\S]*buildRunnerUserData/)
})

test('keeps every Runner instance protected from replacement during full-stack deploys', () => {
  const runnerFactory = configSection('const makeRunner =', '// Default runner')

  assert.match(runnerFactory, /new aws\.ec2\.Instance\(/)
  assert.match(runnerFactory, /ignoreChanges: \['ami', 'userDataBase64'\]/)
  assert.match(runnerFactory, /protect: true/)
  assert.equal(liveConfig.match(/new aws\.ec2\.Instance\(/g)?.length, 1)

  // First boot reads the staged artifact with the instance role, and those two options mean a
  // host that boots before the grant exists never retries. The SSM upgrade path pins the same
  // edge (see the rolling-upgrade test); without this one only half the rule is enforced.
  assert.match(runnerFactory, /dependsOn: \[runnerArtifactPolicy\]/)
})

test('passes both the internal and public OIDC issuers to Proxy', () => {
  const proxyService = configSection("new sst.aws.Service('Proxy'", '// ─── 8.')

  assert.match(proxyService, /OIDC_DOMAIN: oidcIssuer,/)
  assert.match(proxyService, /publicOidcIssuer[\s\S]*OIDC_PUBLIC_DOMAIN: publicOidcIssuer/)
})

test('requires the OIDC client ID through the SST secret store', () => {
  assert.match(liveConfig, /new sst\.Secret\('OIDC_CLIENT_ID'\)/)
  assert.doesNotMatch(liveConfig, /new sst\.Secret\('OIDC_CLIENT_ID',/)
  assert.doesNotMatch(environmentExample, /^OIDC_CLIENT_ID=/m)

  const deploymentGuide = extractSection(readme, '## Deploy an existing stack', '## Secrets & credentials')
  assert.match(deploymentGuide, /npm run bootstrap/)
  assert.match(deploymentGuide, /OIDC_CLIENT_ID/)
  assert.doesNotMatch(deploymentGuide, /App secrets .* are optional/)
  for (const documentation of [readme, environmentExample]) {
    assert.doesNotMatch(documentation, /secret set (?:[A-Z_]+|<NAME>)\s+["']?<[^>\n]+>["']?\s+--stage/)
  }
})

test('the runbook never hands an operator a deploy the wrapper rejects', () => {
  // requireFullStackDeploy throws on --target/--exclude before any preflight runs, so a runbook
  // command carrying one is not a documented escape hatch — it is a step that exits 1.
  // Both spellings reach the same guard: package.json points `deploy` and `sst` at one wrapper,
  // which calls requireFullStackDeploy unconditionally, and that gates on `args[0] === 'deploy'`.
  // `npm run sst --` is what this runbook actually uses, so covering only `npm run deploy` would
  // guard the rarer spelling. Targeted `diff` stays legal and must not be flagged.
  assert.doesNotMatch(readme, /npm run (?:deploy|sst -- deploy)[^\n]*--(?:target|exclude)\b/)
  // The prod stage is `prod`, and PRODUCTION_STAGE is why: a runbook naming `production` sends
  // an operator at a stage that does not exist, which is the same drift the guards above pin.
  assert.doesNotMatch(readme, /\bstage[= ]production\b/)
})

test('data-protection guards key off the stage that actually exists: prod', () => {
  // SST state has app/boxlite/prod.json and no production.json — the real
  // stage is `prod`. The deployed prod stack carries retainOnDelete and
  // deletionProtection because it was deployed from a branch that already
  // compared against 'prod'; main still said 'production', so deploying prod
  // from main would have computed isProd === false and reset them. One
  // constant, both call sites, so the two guards cannot drift apart again.
  assert.match(liveConfig, /const PRODUCTION_STAGE = 'prod'/)
  assert.match(liveConfig, /removal: input\?\.stage === PRODUCTION_STAGE \? 'retain' : 'remove'/)
  assert.match(liveConfig, /const isProd = \$app\.stage === PRODUCTION_STAGE/)
})

test('no stage-name comparison hardcodes a bare production literal', () => {
  // NODE_ENV / ENVIRONMENT: 'production' are Node runtime values, not stages,
  // and must survive; a stage comparison against the string must not.
  //
  // Match any comparison operator and any quote form. Pinning `stage ===
  // 'production'` alone let the inverse, loose equality, and a template
  // literal through — a guard could compare against the wrong stage name and
  // this test would still pass, which is exactly what it exists to prevent.
  assert.doesNotMatch(liveConfig, /\bstage\b\s*(?:===|!==|==|!=)\s*(?:'production'|"production"|`production`)/)
  assert.doesNotMatch(liveConfig, /(?:'production'|"production"|`production`)\s*(?:===|!==|==|!=)\s*\bstage\b/)
  assert.match(liveConfig, /NODE_ENV: 'production'/)
})

test('every local Command pins dir, so it runs from the app root', () => {
  // command.local.Command executes from the Pulumi process's cwd, which is
  // .sst/platform — not the app root. A bare `node scripts/...` therefore
  // resolves to .sst/platform/scripts and fails with "Cannot find module".
  // Only an apply runs these, so a preview cannot catch a missing dir.
  const commands = source.split(/new command\.local\.Command\(/).slice(1)
  assert.ok(commands.length > 0, 'expected at least one command.local.Command in sst.config.ts')
  for (const block of commands) {
    const properties = block.slice(0, block.indexOf('triggers:'))
    assert.match(
      properties,
      /dir: \$cli\.paths\.root/,
      'each command.local.Command must set `dir: $cli.paths.root` or its script path resolves under .sst/platform',
    )
  }
})

test('the prod stage keeps deletion protection and a final snapshot', () => {
  assert.match(liveConfig, /args\.deletionProtection = isProd/)
  assert.match(liveConfig, /args\.skipFinalSnapshot = !isProd/)
})

test('every service built from source is accounted for by the release path', () => {
  // Only apps/api has a published-image path, so a release deploy pins that one and still
  // compiles the rest from the deployed checkout. That is a real limitation the release workflow
  // now states; this pins the set so a fourth built service cannot quietly inherit the gap
  // without someone revisiting either the workflow or that statement.
  const built = [...liveConfig.matchAll(/dockerfile: 'apps\/([^/]+)\/Dockerfile'/g)].map(([, app]) => app)
  assert.deepEqual(built.sort(), ['api', 'otel-collector', 'proxy'])

  const releaseWorkflow = readFileSync(
    new URL('../../../.github/workflows/deploy-release.yml', import.meta.url),
    'utf8',
  )
  assert.match(releaseWorkflow, /apps\/proxy and apps\/otel-collector still build/)
})

test('does not restore the removed SSH gateway deployment', () => {
  assert.doesNotMatch(liveConfig, /SshGateway|SSH_GATEWAY|SSH_PRIVATE_KEY_B64|SSH_HOST_KEY_B64/)
  assert.doesNotMatch(environmentExample, /SSH_GATEWAY|SSH_PRIVATE_KEY_B64|SSH_HOST_KEY_B64/)
  assert.doesNotMatch(readme, /SshGateway|SSH_GATEWAY|SSH_PRIVATE_KEY_B64|SSH_HOST_KEY_B64/)
})

test('passes explicit management API endpoints into the API service', () => {
  const apiService = configSection("const api = new sst.aws.Service('Api'", '// Assumed by the Api task role')

  assert.match(apiService, /OIDC_MANAGEMENT_API_BASE_URL: process\.env\.OIDC_MANAGEMENT_API_BASE_URL/)
  assert.match(apiService, /OIDC_MANAGEMENT_API_TOKEN_URL: process\.env\.OIDC_MANAGEMENT_API_TOKEN_URL/)
})

test('reports the canonical workspace release unless VERSION overrides it', () => {
  assert.match(liveConfig, /const workspaceVersion = readWorkspaceVersion\(\)/)
  assert.match(liveConfig, /resolvePublicDeploymentConfig\(process\.env, workspaceVersion\)/)
  assert.match(liveConfig, /proxyTemplateUrl, releaseVersion \} = deploymentConfig/)

  const apiService = configSection("const api = new sst.aws.Service('Api'", '// Assumed by the Api task role')
  assert.match(apiService, /VERSION: releaseVersion,/)
})

test('the Api deploys either a published image or a build of the deployed checkout', () => {
  // Only one branch runs per deploy, so the other is invisible until someone flips the source.
  // Both are pinned here rather than discovered on the release that first needs them.
  const apiService = configSection('const apiArtifact = resolveArtifactSource', '// Assumed by the Api task role')

  assert.match(liveConfig, /const \{ resolveArtifactSource \} = await import\('\.\/scripts\/artifact-source\.mjs'\)/)
  assert.match(apiService, /apiArtifact\.kind === 'release'/)
  // Three outcomes, not two: a release tag, a commit tag, and — only when no ref was resolved —
  // the local build context. Losing the `|| apiArtifact.ref` arm would silently put CI back to
  // compiling the Api inside `sst deploy` while its build job still published an image.
  assert.match(apiService, /apiArtifact\.kind === 'release' \|\| apiArtifact\.ref/)
  // The reference is built by the shared helper, which validates the repository name, rather
  // than re-derived here where a bad stage would only surface as an AWS error mid-deploy.
  assert.match(liveConfig, /const \{ apiImageReference \} = await import\('\.\/scripts\/api-artifact\.mjs'\)/)
  // Pin each argument, not just the call: `[\s\S]*` swallowed them, and api-artifact.mjs does not
  // validate region — a missing one yields `dkr.ecr.undefined.amazonaws.com` at deploy time.
  const imageReference = extractSection(liveConfig, 'apiImageReference({', '})')
  for (const argument of [
    /app: \$app\.name/,
    /stage: \$app\.stage/,
    /accountId/,
    /region: REGION/,
    /version: apiArtifact\.version/,
    // A release names a bare version; passing its ref through would look up a tag that only a
    // commit build ever pushes, and the preflight would refuse a perfectly good release.
    /ref: apiArtifact\.kind === 'release' \? undefined : apiArtifact\.ref/,
  ]) {
    assert.match(imageReference, argument)
  }
  assert.doesNotMatch(apiService, /dkr\.ecr\./)
  assert.match(apiService, /\{ context: '\.\.\/\.\.', dockerfile: 'apps\/api\/Dockerfile' \}/)
  // The repository must predate the stack that consumes it; the stage bootstrap owns it.
  assert.doesNotMatch(apiService, /new aws\.ecr\.Repository/)
  // A cross-reference in a comment, deliberately read from the raw file: the point is that
  // sst.config.ts tells a reader where the repository is created, not that anything executes.
  assert.match(source, /ci\/github-deploy-role\.yaml/)
})

test('the Runner can read only staged build artifacts from the bootstrapped bucket', () => {
  const runner = configSection('─── 10. RUNNER', '// ── Runner ghcr pull credential')
  const artifactPolicy = extractSection(
    runner,
    "new aws.iam.RolePolicy('RunnerArtifactS3Policy'",
    'const runnerInstanceProfile',
  )

  assert.match(runner, /runnerArtifactsBucketName\(\{ app: \$app\.name, stage: \$app\.stage, accountId \}\)/)
  assert.match(artifactPolicy, /Action: \['s3:GetObject'\]/)
  assert.match(artifactPolicy, /Resource: `arn:aws:s3:::\$\{artifactsBucketName\}\/runner\/\*`/)
  // Both spellings, and `sst.aws.Bucket` is the one that matters: it is what this config
  // actually uses elsewhere (the Storage bucket), so it is how "the stack creates the input it
  // is supposed to consume" would most plausibly come back. The raw-Pulumi form appears nowhere
  // in the file today, so pinning only that would have guarded a spelling nobody writes here.
  assert.doesNotMatch(runner, /new (?:aws\.s3\.Bucket(?:V2)?|sst\.aws\.Bucket)\b/)
  assert.doesNotMatch(artifactPolicy, /s3:(?:PutObject|DeleteObject|ListBucket)/)
})

test('Runner bootstrap fetches the selected artifact and fails closed on its checksum', () => {
  // This function is a TypeScript template emitting bash that runs as root on first boot. Strip
  // both comment styles: the whole verify-then-extract sequence below is otherwise satisfied by
  // a script in which every check has been demoted to a `#` comment.
  const runnerBootstrap = configSection('async function buildRunnerUserData')

  assert.match(runnerBootstrap, /artifactFetchCommand\(/)
  assert.match(runnerBootstrap, /const fetchTarball = artifactFetchCommand/)
  assert.match(runnerBootstrap, /const fetchChecksum = artifactFetchCommand/)
  assert.match(runnerBootstrap, /\$\{fetchTarball\}[\s\S]*\$\{fetchChecksum\}/)
  assert.match(runnerBootstrap, /checksum manifest does not name/)
  assert.ok(runnerBootstrap.includes(`'\\$2 == name || \\$2 == "*" name {print \\$1}'`))
  // The comparison itself, not just its error message: the message survives commenting.
  assert.match(runnerBootstrap, /EXPECTED=\\\$\(awk/)
  assert.match(runnerBootstrap, /ACTUAL=\\\$\(sha256sum/)
  assert.match(runnerBootstrap, /\[ "\\\$EXPECTED" = "\\\$ACTUAL" \]/)
  assert.match(runnerBootstrap, /runner checksum mismatch/)
  assert.ok(
    runnerBootstrap.indexOf('runner checksum mismatch') < runnerBootstrap.indexOf('tar -xzf'),
    'checksum verification must precede extracting the root-owned binary',
  )
})

test('upgrades every Runner through a dependsOn chain, one host per command', () => {
  // The chain is the only thing sequencing the restarts, and it cannot be observed
  // without a real deploy — so it is pinned here, next to the other deploy-shape
  // invariants, rather than left to prose.
  const upgrades = configSection('── Rolling runner binary upgrade')

  // Every Runner gets a command: the default (captured for exactly this) plus each extra.
  assert.match(liveConfig, /const defaultRunner = makeRunner\(/)
  assert.match(upgrades, /\{ label: 'default', instance: defaultRunner \}/)
  assert.match(upgrades, /\.\.\.extraRunners\.map\(\(r\) => \(\{ label: r\.name, instance: r\.instance \}\)\)/)
  assert.match(upgrades, /new command\.local\.Command\(\s*`UpgradeRunnerBinary-\$\{label\}`/)

  // Each command waits on the previous one, so two Runners never restart at once.
  assert.match(upgrades, /previousUpgrade = new command\.local\.Command/)
  // The artifact grant is a prerequisite, not a sibling: build mode reads S3 with the instance
  // role, and Pulumi sees no edge because the bucket reaches the command as a plain string.
  assert.match(
    upgrades,
    /dependsOn: \[instance, runnerArtifactPolicy, \.\.\.\(previousUpgrade \? \[previousUpgrade\] : \[\]\)\]/,
  )
  assert.match(liveConfig, /const runnerArtifactPolicy = new aws\.iam\.RolePolicy\('RunnerArtifactS3Policy'/)

  // Exactly one host per command. A release bump or a build commit change re-runs it.
  assert.match(upgrades, /INSTANCE_IDS: instance\.id/)
  assert.match(upgrades, /const runnerTargetVersion = runnerArtifactSource\.version/)
  assert.match(upgrades, /`build:\$\{runnerArtifactSource\.version\}:\$\{runnerArtifactSource\.ref\}`/)
  assert.match(upgrades, /`release:\$\{runnerArtifactSource\.version\}`/)
  assert.match(upgrades, /RUNNER_VERSION: runnerTargetVersion/)
  assert.match(upgrades, /triggers: \[runnerArtifactTrigger, instance\.id\]/)
  // `triggers` replaces the resource, so `create` must carry the same body as `update`.
  assert.match(
    upgrades,
    /create: 'node scripts\/runner-update-binary\.mjs',\s*update: 'node scripts\/runner-update-binary\.mjs',/,
  )
})

test('no longer points operators at the deleted shell updater', () => {
  assert.doesNotMatch(liveConfig, /scripts\/deploy\/runner-update-binary\.sh/)
  assert.doesNotMatch(readme, /runner-update-binary\.sh/)
  assert.match(readme, /scripts\/runner-update-binary\.mjs/)
})

// BILLING_API_URL used to do more than tell the dashboard where to call: while organization
// creation keyed off it, pointing it anywhere made the API create every non-default organization
// suspended with 'Payment method required' — unclearable by a mock that registers no card. That
// coupling is what must not come back. Suspension is now gated on its own flag, so the guard
// belongs on the condition rather than on the URL.
test('organization suspension is gated on its own flag, not on BILLING_API_URL', () => {
  const organizationService = liveText(
    'scriptEmittingShell',
    readFileSync(new URL('../../api/src/organization/services/organization.service.ts', import.meta.url), 'utf8'),
  )
  // The reason string is only ever produced under the dedicated flag.
  assert.match(organizationService, /configService\.get\('requirePaymentMethod'\)/)
  assert.doesNotMatch(organizationService, /configService\.get\('billingApiUrl'\)/)
  assert.match(
    readFileSync(new URL('../../api/src/config/configuration.ts', import.meta.url), 'utf8'),
    /requirePaymentMethod: process\.env\.REQUIRE_PAYMENT_METHOD === 'true'/,
  )
})

// The dashboard decides whether its Wallet, Spending and Limits pages exist by whether the Api sent a
// billing URL, so advertising one on a stage that deploys no billing service renders pages whose
// every request 404s. The producing and consuming sides sit in different packages: nothing but a
// cross-file guard notices when one of them moves.
test('a billing URL is advertised only where a billing service answers', () => {
  assert.match(liveConfig, /\.\.\.\(\(process\.env\.BILLING_API_URL \|\| commerceImageTag\) && \{/)
  assert.match(liveConfig, /BILLING_API_URL: envOr\('BILLING_API_URL', `https:\/\/commerce\.\$\{stackDomain\}\/api\/billing`\)/)

  const app = liveText(
    'script',
    readFileSync(new URL('../../dashboard/src/App.tsx', import.meta.url), 'utf8'),
  )
  // Every billing page must be inside that gate — a <Route> outside it renders against
  // the dashboard's own origin — and out of the force-redirect list, or the gate is dead
  // code. Limits is here too because it carries the subscription surface.
  // The closer is matched at its own indentation: `)}` alone would hit the first
  // `getRouteSubPath(...)}` and cut the block off before any route.
  const billingRoutes = extractSection(app, '{config.billingApiUrl && (', '\n        )}')
  for (const route of ['BILLING_SPENDING', 'BILLING_WALLET', 'LIMITS']) {
    assert.match(billingRoutes, new RegExp(`getRouteSubPath\\(RoutePath\\.${route}\\)`))
  }
  const hiddenRoutes = extractSection(app, 'const HIDDEN_DASHBOARD_ROUTES = [', ']')
  for (const route of ['BILLING_SPENDING', 'BILLING_WALLET', 'LIMITS']) {
    assert.doesNotMatch(hiddenRoutes, new RegExp(route))
  }
})

// The image lives in another repository's ECR push, so a stage that never published one cannot
// build it locally either. With `wait: true`, handing SST a reference that cannot resolve hangs
// that stage's entire deploy on an ECS pull failure — so the service must stay conditional, and
// the tag must not fall back to a default on stages other than DEFAULT_STAGE.
test('declares Commerce only for a stage that has a published image', () => {
  // One derivation, read twice: the reference the Service pulls and the gate the Api
  // advertises must agree, or a stage could publish a billing URL for a service it
  // never declares. Scoped to the reference call's own argument list, so a dead
  // `tag: commerceImageTag` elsewhere cannot stand in for the tag this image resolves.
  assert.match(
    liveConfig,
    /const commerceImageTag = envOr\('COMMERCE_IMAGE_TAG', \$app\.stage === DEFAULT_STAGE \? COMMERCE_PINNED_IMAGE_TAG : ''\)/,
  )
  assert.match(liveConfig, /if \(commerceImage\) \{/)
  const imageReference = extractSection(liveConfig, 'const commerceImage = commerceImageReference({', '})')
  assert.match(imageReference, /tag: commerceImageTag,/)
  // Composition and tag validation belong to commerce-artifact.mjs, as the Api's do to
  // api-artifact.mjs; a registry URL assembled inline would skip both.
  assert.doesNotMatch(liveConfig, /dkr\.ecr\./)
  // Named constants, not bare literals at the point of use — the drift PRODUCTION_STAGE prevents.
  assert.match(liveConfig, /const DEFAULT_STAGE = 'dev'/)
  assert.match(liveConfig, /const COMMERCE_PINNED_IMAGE_TAG = '[0-9a-f]{40}'/)
  // The repository must predate the stack that consumes it; the stage bootstrap owns it.
  assert.match(readFileSync(new URL('../ci/github-deploy-role.yaml', import.meta.url), 'utf8'), /-commerce/)
  assert.match(environmentExample, /^# COMMERCE_IMAGE_TAG=/m)
})
