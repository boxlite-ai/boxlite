import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  addressFor,
  addressesFor,
  artifactRegistryHost,
  assertTag,
  ecrHost,
  ImageAddressError,
  resolveRegistry,
} from '../src/address.ts'
import { BuildConfigError, parseBuildConfig, registryFor } from '../src/config.ts'

const SCAN = { blockOn: ['CRITICAL', 'HIGH'], timeoutSeconds: 300 }

const declare = (stages: Record<string, unknown>) =>
  parseBuildConfig({
    basePath: '/repo/apps/infra/mstage.env.json',
    base: JSON.stringify({
      root: '../..',
      artifacts: {
        console: { dockerfile: 'apps/console/Dockerfile', context: '.' },
        api: { dockerfile: 'apps/api/Dockerfile', context: '.' },
      },
    }),
    stagePath: '/repo/apps/infra/.mstage.config.json',
    stages: JSON.stringify({ stages }),
  })

const ecrStage = (repository: string) => ({
  home: 'aws',
  registry: { kind: 'ecr', repository, immutableTags: true, scanOnPush: true },
  scan: SCAN,
})

const onArtifactRegistry = () =>
  declare({
    dev: {
      home: 'gcp',
      registry: {
        kind: 'artifact-registry',
        repository: 'boxlite-backoffice',
        immutableTags: true,
        scanOnPush: true,
      },
      scan: SCAN,
    },
  })

const config = declare({
  dev: ecrStage('boxlite-backoffice-dev'),
  prod: ecrStage('boxlite-backoffice-prod'),
})

/** What mstage declares. mbuild's own file deliberately does not repeat it. */
const REGION = { dev: 'ap-southeast-1', prod: 'us-east-1' }

const SHA = 'a'.repeat(40)
const ACCOUNT = '000000000000'

test('the repository comes from mbuild and the region from mstage', () => {
  // Two files, one key each. mbuild says which repository receives a stage's
  // artifacts; mstage says where that stage lives, and is not copied here.
  const dev = resolveRegistry({ config, stage: 'dev', region: REGION.dev, accountId: ACCOUNT })
  const prod = resolveRegistry({ config, stage: 'prod', region: REGION.prod, accountId: ACCOUNT })
  assert.equal(
    addressFor({ config, registry: dev, artifact: 'api', tag: SHA }),
    `000000000000.dkr.ecr.ap-southeast-1.amazonaws.com/boxlite-backoffice-dev:${SHA}-api`,
  )
  assert.equal(
    addressFor({ config, registry: prod, artifact: 'api', tag: SHA }),
    `000000000000.dkr.ecr.us-east-1.amazonaws.com/boxlite-backoffice-prod:${SHA}-api`,
  )
})

test('the two registry kinds put the artifact in different halves of the address', () => {
  // The whole reason the module exists: a caller concatenating its own string
  // would work against one registry and be silently wrong for the other.
  const gcp = onArtifactRegistry()
  const registry = resolveRegistry({ config: gcp, stage: 'dev', region: 'asia-southeast1', project: 'boxlite' })
  assert.equal(
    addressFor({ config: gcp, registry, artifact: 'api', tag: SHA }),
    `asia-southeast1-docker.pkg.dev/boxlite/boxlite-backoffice/api:${SHA}`,
  )
})

test('a stage the file does not declare is a typo, not a new environment', () => {
  // Publishing into an undeclared repository would create it, and nothing
  // would ever pull from it.
  assert.throws(() => registryFor(config, 'staging'), BuildConfigError)
  assert.throws(() => registryFor(config, 'staging'), /declares no stage "staging"\. Declared: dev, prod/)
})

test('each kind is refused the coordinates it cannot use', () => {
  assert.throws(() => resolveRegistry({ config, stage: 'dev', region: REGION.dev }), /needs an account id/)
  assert.throws(
    () => resolveRegistry({ config: onArtifactRegistry(), stage: 'dev', region: 'asia-southeast1' }),
    /needs a project/,
  )
})

test('a stage mstage gives no region cannot be addressed', () => {
  // The failure this prevents is an address with an empty segment, which points
  // at a registry that does not exist and reads almost like one that does.
  assert.throws(
    () => resolveRegistry({ config, stage: 'dev', region: '  ', accountId: ACCOUNT }),
    /mstage declares where a stage lives/,
  )
})

test('a tag that is not one full commit SHA is refused', () => {
  // A deploy names exact bytes; `latest` or a short sha would break that, and
  // an immutable tag cannot be repointed to fix it afterwards.
  assert.throws(() => assertTag('latest'), ImageAddressError)
  assert.throws(() => assertTag(SHA.slice(0, 7)), /one full lowercase commit SHA/)
  assert.throws(() => assertTag(SHA.toUpperCase()), /one full lowercase commit SHA/)
  assert.equal(assertTag(SHA), SHA)
})

test('an artifact the config does not declare cannot be addressed', () => {
  const registry = resolveRegistry({ config, stage: 'dev', region: REGION.dev, accountId: ACCOUNT })
  assert.throws(
    () => addressFor({ config, registry, artifact: 'worker', tag: SHA }),
    /declares no artifact "worker"\. Declared: console, api/,
  )
})

test('every declared artifact is addressable at one commit', () => {
  const registry = resolveRegistry({ config, stage: 'dev', region: REGION.dev, accountId: ACCOUNT })
  assert.deepEqual(Object.keys(addressesFor({ config, registry, tag: SHA })), ['console', 'api'])
})

test('the hosts are built here, not at the call sites that used to', () => {
  assert.equal(
    ecrHost({ accountId: ACCOUNT, region: 'ap-southeast-1' }),
    `${ACCOUNT}.dkr.ecr.ap-southeast-1.amazonaws.com`,
  )
  assert.throws(() => ecrHost({ accountId: 'boxlite', region: 'ap-southeast-1' }), /twelve digits/)
  assert.equal(artifactRegistryHost('asia-southeast1'), 'asia-southeast1-docker.pkg.dev')
})

test('the committed files declare the artifacts that are actually built', () => {
  // Not a fixture: the real base file, so an artifact added to one without the
  // other is caught here rather than at the first deploy that cannot find its
  // image. Paired with the committed example of the stage file, which is what
  // a new checkout copies — an example that no longer parses is worse than
  // none, because it is copied before it is read.
  const basePath = new URL('../../mstage.env.json', import.meta.url)
  const stagePath = new URL('../../.mstage.config.example.json', import.meta.url)
  const real = parseBuildConfig({
    basePath: basePath.pathname,
    base: readFileSync(basePath, 'utf8'),
    stagePath: stagePath.pathname,
    stages: readFileSync(stagePath, 'utf8'),
  })
  // What is built belongs to each repository, so this asserts the rule rather
  // than a pair of names: something is built, and every declared artifact gets
  // exactly one composed address. `publish.test.ts` is where those Dockerfiles
  // are checked to exist; here the question is only that the two halves of the
  // committed pair agree with each other.
  const artifacts = Object.keys(real.artifacts).sort()
  assert.ok(artifacts.length > 0, 'mstage.env.json declares nothing to build')
  /*
   * Both coordinates, because which one `dev` needs depends on the cloud it
   * lives in and that is each repository's own choice — `resolveRegistry` reads
   * the one its declared kind calls for and ignores the other. They are
   * placeholders: nothing below asserts the composed host, only that every
   * declared artifact got exactly one address.
   */
  const registry = resolveRegistry({
    config: real,
    stage: 'dev',
    region: 'ap-southeast-1',
    accountId: '123456789012',
    project: 'p',
  })
  assert.deepEqual(Object.keys(addressesFor({ config: real, registry, tag: SHA })).sort(), artifacts)
  // `dev` by name, because that is the stage the workflows name and every
  // checkout declares. How many others there are is not this test's to know —
  // the example belongs to each repository — so the rule below is checked over
  // whatever is declared rather than over a pair written in here: one stage has
  // nowhere to promote to, and two must not point at the same repository.
  const stages = Object.keys(real.stages)
  assert.ok(stages.includes('dev'), `.mstage.config.example.json must declare dev; declares ${stages.join(', ')}`)
  assert.deepEqual(real.stages.dev!.scan.blockOn, ['CRITICAL', 'HIGH'])
  const repositories = stages.map((stage) => registryFor(real, stage).repository)
  assert.equal(
    new Set(repositories).size,
    repositories.length,
    'two stages sharing one repository would make promoting between them a no-op',
  )
})

test('a stage that lives in GCP cannot declare an ECR repository', () => {
  // One decision spelled twice in one block, so the parser is where it is
  // held. An `ecr` repository on a stage whose workloads are Cloud Run
  // services is an address nothing in that project can pull, and the deploy
  // that finds out has already built a network.
  assert.throws(
    () => declare({ dev: { home: 'gcp', project: 'p', registry: ecrStage('r').registry, scan: SCAN } }),
    /lives in gcp and must publish to artifact-registry, not ecr/,
  )
  assert.throws(
    () => declare({ dev: { home: 'aws', registry: onArtifactRegistry().stages.dev!.registry, scan: SCAN } }),
    /lives in aws and must publish to ecr, not artifact-registry/,
  )
})

test("mdeploy's half of the block is carried past mbuild, and a typo in mbuild's own is not", () => {
  // Three tools read one stage block. `deploy` is mdeploy's — refused here it
  // would make a stage undeployable and unpublishable at once — while `registy`
  // silently ignored is a stage that publishes nowhere.
  const withDeploy = declare({
    dev: { ...ecrStage('boxlite-backoffice-dev'), deploy: { service: 'console', cpu: '1' } },
  })
  assert.equal(registryFor(withDeploy, 'dev').repository, 'boxlite-backoffice-dev')
  assert.equal(
    (withDeploy.stages.dev as Record<string, unknown>).deploy,
    undefined,
    'tolerated is not the same as read: mbuild keeps nothing it has no use for',
  )
  assert.throws(() => declare({ dev: { ...ecrStage('r'), registy: {} } }), /does not take registy/)
})

test('a stage mstage declares but nothing publishes into is refused at load', () => {
  // The two tools read one block, so a stage that says where it lives without
  // saying where it uploads used to deploy and then fail to pull. It now fails
  // to parse instead, which is before anything has been created.
  assert.throws(() => declare({ dev: { home: 'aws', region: 'ap-southeast-1' } }), /must set registry, scan/)
})
