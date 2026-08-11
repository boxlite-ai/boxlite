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

test('registers Cloudflare only when the credential pair is present', async () => {
  const { resolveCloudflareProviderRegistration } = await import('./cloudflare-provider-registration.mjs')
  assert.deepEqual(resolveCloudflareProviderRegistration({}), {})
  assert.deepEqual(
    resolveCloudflareProviderRegistration({ BOXLITE_SST_INSTALL_PROVIDERS: '1' }),
    { cloudflare: '6.15.0' },
    'credential-free sst install must still declare every pinned provider',
  )
  assert.deepEqual(
    resolveCloudflareProviderRegistration({
      CLOUDFLARE_API_TOKEN: 'synthetic-token',
      CLOUDFLARE_DEFAULT_ACCOUNT_ID: 'synthetic-account',
    }),
    { cloudflare: '6.15.0' },
  )
  for (const environment of [
    { CLOUDFLARE_API_TOKEN: 'secret-token-sentinel' },
    { CLOUDFLARE_DEFAULT_ACCOUNT_ID: 'secret-account-sentinel' },
  ]) {
    assert.throws(
      () => resolveCloudflareProviderRegistration(environment),
      (error) => {
        assert.match(error.message, /must be supplied together/)
        assert.doesNotMatch(error.message, /secret-(?:token|account)-sentinel/)
        return true
      },
    )
  }

  const appSource = configSection('async app(input)', 'async run()')
  assert.match(appSource, /resolveCloudflareProviderRegistration/)
  assert.match(appSource, /\.\.\.cloudflareProviderRegistration/)
  assert.doesNotMatch(appSource, /cloudflare:\s*'6\.15\.0'/)
})

test('pins only the historical load-balancer type secrecy and removes container dependencies', () => {
  const services = [
    {
      name: 'Jaeger',
      source: configSection("const jaeger = new sst.aws.Service('Jaeger'", 'const jaegerOtlpHttpEndpoint'),
      type: /loadBalancerType\s*=\s*'application'/,
    },
    {
      name: 'OtelCollector',
      source: configSection(
        "const otelCollector = new sst.aws.Service('OtelCollector'",
        'const otelCollectorOtlpHttpUrl',
      ),
      type: /loadBalancerType\s*=\s*\$util\.secret\('application'\)/,
    },
    {
      name: 'Api',
      source: configSection("const api = new sst.aws.Service('Api'", '// Assumed by the Api task role'),
      type: /loadBalancerType\s*=\s*\$util\.secret\('application'\)/,
    },
    {
      name: 'Proxy',
      source: configSection("new sst.aws.Service('Proxy'", '// ─── 8.'),
      type: /loadBalancerType\s*=\s*\$util\.secret\('network'\)/,
    },
    {
      name: 'PgAdmin',
      source: configSection("new sst.aws.Service('PgAdmin'", '// MailDev is an unauthenticated'),
      type: /loadBalancerType\s*=\s*\$util\.secret\('application'\)/,
    },
    {
      name: 'MailDev',
      source: configSection("new sst.aws.Service('MailDev'", '// ─── 9.'),
      type: /loadBalancerType\s*=\s*'application'/,
    },
  ]

  for (const service of services) {
    assert.doesNotMatch(service.source, /loadBalancer:\s*\$util\.secret\(/, `${service.name} over-taints its LB`)
    assert.match(service.source, service.type, `${service.name} does not preserve its exact LB type shape`)
  }
})

test('applies the deployment permissions boundary to every SST-created IAM role', () => {
  assert.match(liveConfig, /const runtimePermissionsBoundaryArn =/)
  assert.match(liveConfig, /requireIamPermissionsBoundaryStage\(\$app\.stage\)/)
  assert.match(environmentExample, /^# IAM_PERMISSIONS_BOUNDARY_STAGE=dev$/m)
  assert.doesNotMatch(environmentExample, /^IAM_PERMISSIONS_BOUNDARY_STAGE=/m)
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

test('tags Runner instances with their exact immutable deployment and control-plane identity', () => {
  const runnerResources = configSection('const makeRunner =', '// Register the extra runners')

  assert.match(liveConfig, /import\('\.\/scripts\/runner-inventory\.cjs'\)/)
  assert.match(liveConfig, /const runnerInventory = resolveRunnerInventory\(process\.env\)/)
  assert.match(runnerResources, /'boxlite:control-plane-runner-name': controlPlaneRunnerName/)
  assert.match(runnerResources, /\[RUNNER_STAGE_TAG\]: \$app\.stage/)
  assert.match(runnerResources, /\[RUNNER_ROLE_TAG\]: RUNNER_ROLE_VALUE/)
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
  assert.match(runnerFactory, /dependsOn: access\.policies/)
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
  // resolveDeployScope throws before any preflight runs, so a runbook command it refuses is not a
  // documented escape hatch — it is a step that exits 1. Both spellings reach the same guard:
  // package.json points `deploy` and `sst` at one wrapper, which resolves the scope
  // unconditionally, and that gates on `args[0] === 'deploy'`. `npm run sst --` is what this
  // runbook actually uses, so covering only `npm run deploy` would guard the rarer spelling.
  // Targeted `diff` stays legal and must not be flagged.
  //
  // `--target` is still refused for deploys; `--exclude` is refused for anything but the two
  // reviewed component scopes, so the runbook may show those and nothing else.
  assert.doesNotMatch(readme, /npm run (?:deploy|sst -- deploy)[^\n]*--target\b/)
  for (const [, excluded] of readme.matchAll(/npm run (?:deploy|sst -- deploy)[^\n]*--exclude[=\s]+(\S+)/g)) {
    assert.ok(
      ['Api', 'Runner'].includes(excluded),
      `the runbook documents --exclude ${excluded}, which resolveDeployScope refuses`,
    )
  }
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

test('the Runner binary upgrade is declared only when the Runner is in scope', () => {
  // `--exclude Runner` keeps the EC2 instance out of the plan, but UpgradeRunnerBinary-* is a
  // sibling of it, not a child, and SST is never passed --exclude-dependents. Its trigger carries
  // the deployed commit, so left declared on an Api-only deploy it fetches runner/<sha>/ for a
  // commit whose build-runner job was skipped. deployment-preview.mjs cannot catch that:
  // isRunnerLikeResource matches a name against /^Runner(?:-|$)/ OR an aws:ec2/instance:Instance
  // carrying Runner identity tags, and this command satisfies neither arm.
  const live = liveText('scriptEmittingShell', source)
  assert.match(live, /const deploysRunner = readDeployScope\(\)\.includes\('runner'\)/)
  assert.match(live, /readDeployScope \} = await import\('\.\/scripts\/deployment-scope\.mjs'\)/)
  // The gate must sit on the loop that constructs them, not merely exist somewhere in the file.
  const upgradeIndex = live.indexOf('`UpgradeRunnerBinary-${label}`')
  assert.notEqual(upgradeIndex, -1, 'the Runner upgrade command is missing')
  const loopHeader = live.slice(live.lastIndexOf('let previousUpgrade', upgradeIndex), upgradeIndex)
  assert.match(loopHeader, /!deploysRunner\s*\?\s*\[\]/, 'the upgrade loop is not gated on the deploy scope')
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
  const artifactPolicyDocument = extractSection(
    runner,
    'const runnerArtifactS3PolicyDocument',
    'const runnerRole',
  )

  assert.match(runner, /runnerArtifactsBucketName\(\{ app: \$app\.name, stage: \$app\.stage, accountId \}\)/)
  assert.match(artifactPolicy, /policy: runnerArtifactS3PolicyDocument/)
  assert.match(artifactPolicyDocument, /Action: \['s3:GetObject'\]/)
  assert.match(artifactPolicyDocument, /Resource: `arn:aws:s3:::\$\{artifactsBucketName\}\/runner\/\*`/)
  // Both spellings, and `sst.aws.Bucket` is the one that matters: it is what this config
  // actually uses elsewhere (the Storage bucket), so it is how "the stack creates the input it
  // is supposed to consume" would most plausibly come back. The raw-Pulumi form appears nowhere
  // in the file today, so pinning only that would have guarded a spelling nobody writes here.
  assert.doesNotMatch(runner, /new (?:aws\.s3\.Bucket(?:V2)?|sst\.aws\.Bucket)\b/)
  assert.doesNotMatch(artifactPolicyDocument, /s3:(?:PutObject|DeleteObject|ListBucket)/)
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
  assert.match(
    upgrades,
    /\{ label: 'default', instance: defaultRunner, artifactPolicy: runnerArtifactPolicy \}/,
  )
  assert.match(upgrades, /\.\.\.extraRunners\.map\(\(r\) => \(\{[\s\S]*artifactPolicy: extraRunnerArtifactPolicy/)
  assert.match(upgrades, /new command\.local\.Command\(\s*`UpgradeRunnerBinary-\$\{label\}`/)

  // Each command waits on every extra-runner GHCR migration and the previous
  // upgrade, so no binary restart races the credential-reference convergence
  // and two Runners never restart at once.
  assert.match(upgrades, /previousUpgrade = new command\.local\.Command/)
  // The artifact grant is a prerequisite, not a sibling: build mode reads S3 with the instance
  // role, and Pulumi sees no edge because the bucket reaches the command as a plain string.
  assert.match(
    upgrades,
    /dependsOn: \[\s*instance,\s*artifactPolicy,\s*\.\.\.extraRunnerGhcrMigrations,\s*\.\.\.\(previousUpgrade \? \[previousUpgrade\] : \[\]\),?\s*\]/,
  )
  assert.match(liveConfig, /const runnerArtifactPolicy = new aws\.iam\.RolePolicy\('RunnerArtifactS3Policy'/)
  assert.match(liveConfig, /const extraRunnerArtifactPolicy = new aws\.iam\.RolePolicy\('ExtraRunnerArtifactS3Policy'/)

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

// The dashboard decides whether its billing surfaces exist by whether the Api sent a billing URL,
// so advertising one on a stage that deploys no billing service renders pages whose every request
// 404s. The producing and consuming sides sit in different packages: nothing but a cross-file
// guard notices when one of them moves.
test('a billing URL is advertised only where a billing service answers', () => {
  // Shape, not formatting: the block gained usage-export settings on the same gate, so pinning
  // the one-line spelling would fail on a change that keeps the guarantee exactly. What matters
  // is that the gate is the env var and the value is passed through with no default behind it.
  assert.match(liveConfig, /\.\.\.\(process\.env\.BILLING_API_URL && \{/)
  assert.match(liveConfig, /BILLING_API_URL: process\.env\.BILLING_API_URL,/)
  assert.doesNotMatch(liveConfig, /BILLING_API_URL: envOr\(/)

  // Wallet, plan and usage are sections of one /dashboard/billing page, so the gate moved from
  // the route table into that page: it must refuse to render any section — none of which can
  // load without the billing origin — before it reads one, and return the placeholder instead.
  const billing = liveText(
    'script',
    readFileSync(new URL('../../dashboard/src/pages/Billing.tsx', import.meta.url), 'utf8'),
  )
  const gate = billing.indexOf('if (!config.billingApiUrl)')
  assert.notEqual(gate, -1, 'Billing page must gate on config.billingApiUrl')
  assert.match(billing.slice(gate), /return <BillingComingSoon \/>/)
  for (const section of ['<BillingAlerts />', '<PlanSection />', '<UsageSection />', '<WalletSection />']) {
    assert.ok(billing.indexOf(section) > gate, `${section} must render only past the billing gate`)
  }

  // The per-surface paths that used to be gated are now redirects into that page. A redirect
  // issues no request of its own, so it is safe ungated — but it must not render a page, and
  // must stay out of the force-redirect list that would send it to /boxes instead.
  const app = liveText(
    'script',
    readFileSync(new URL('../../dashboard/src/App.tsx', import.meta.url), 'utf8'),
  )
  const redirectedRoutes = ['BILLING_SPENDING', 'BILLING_WALLET', 'LIMITS', 'PRICING']
  for (const route of redirectedRoutes) {
    // extractSection excludes its end marker, so the closer is matched by the marker itself.
    const routeLine = extractSection(app, `getRouteSubPath(RoutePath.${route})`, '/>')
    assert.match(routeLine, /element=\{<Navigate to=\{RoutePath\.BILLING\} replace $/)
  }
  const hiddenRoutes = extractSection(app, 'const HIDDEN_DASHBOARD_ROUTES = [', ']')
  for (const route of redirectedRoutes) {
    assert.doesNotMatch(hiddenRoutes, new RegExp(route))
  }
})

// Where usage is shipped and where the dashboard calls are one letter apart in intent and a whole
// route apart in fact: the publisher appends /internal/usage-events, which the billing service
// serves off its bare origin because that route authenticates a service rather than a user, so it
// sits outside the /api/billing prefix (boxlite-commerce src/http.ts). Handing the exporter
// BILLING_API_URL's value is the plausible edit that 404s every batch, silently, for as long as
// nobody reads the outbox — and the two sides sit in different repositories, where no type checks
// the seam. Deriving the origin is what makes the two impossible to point apart by accident.
test('usage is exported to the ingest origin, never to the dashboard billing URL', () => {
  assert.match(
    liveConfig,
    /USAGE_EXPORT_URL: envOr\('USAGE_EXPORT_URL', new URL\(process\.env\.BILLING_API_URL\)\.origin\)/,
  )
  assert.doesNotMatch(liveConfig, /USAGE_EXPORT_URL: envOr\([^)]*\/api\/billing/)

  // Delivery is gated on the credential, not asserted alongside it: configuration.ts throws when
  // export is enabled without a token, so a stage pointed at a billing service but holding no
  // secret must come up exporting nothing rather than crash-loop on boot.
  assert.match(liveConfig, /USAGE_EXPORT_TOKEN: usageExportToken\.value/)
  assert.match(
    liveConfig,
    /USAGE_EXPORT_ENABLED: usageExportToken\.value\.apply\(\(token\) => \(token\.trim\(\) \? 'true' : 'false'\)\)/,
  )
  assert.match(liveConfig, /const usageExportToken = new sst\.Secret\('USAGE_EXPORT_TOKEN', ''\)/)

  // Nothing here can discover the receiving half — it belongs to the billing service's own stack —
  // so the note naming the value to set is the only thing between an operator and a stage that
  // 401s every batch, and it must keep naming it.
  assert.match(environmentExample, /^# USAGE_EXPORT_URL=/m)
  assert.match(environmentExample, /boxlite-commerce\/<stage>\/usage-ingest-token/)
  assert.doesNotMatch(environmentExample, /^USAGE_EXPORT_TOKEN=/m)
})
