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
  RELEASE_VERSION,
  releaseTagFor,
  resolveRegistry,
} from '../src/address.ts'
import { BuildConfigError, onlyArtifact, parseBuildConfig, registryFor } from '../src/config.ts'

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
/** A released version as its git tag spells it. */
const VERSION = 'v1.2.3'

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

test('a stage may declare that it blocks on nothing, and says so in a word', () => {
  /*
   * The escape hatch, and the shape of it is the point. An empty `blockOn`
   * array would read like a field somebody forgot to fill; `"none"` reads like
   * the decision it is, which is what a reviewer has to be able to see.
   */
  const config = declare({ dev: { ...ecrStage('boxlite-backoffice-dev'), scan: { blockOn: 'DISABLED' } } })
  assert.deepEqual(config.stages.dev!.scan, { blockOn: 'DISABLED' })

  /*
   * The budget left beside it is dropped rather than refused. Turning the gate
   * off is one field; making the operator delete a second one to be allowed to
   * do it buys nothing, and the parsed policy carries no timeout either way.
   */
  const kept = declare({
    dev: { ...ecrStage('boxlite-backoffice-dev'), scan: { blockOn: 'DISABLED', timeoutSeconds: 300 } },
  })
  assert.deepEqual(kept.stages.dev!.scan, { blockOn: 'DISABLED' }, 'the unused budget must not reach the policy')

  /*
   * Both near misses get the message that names the right placement. `['NONE']`
   * is the one somebody reaches for first, and it is also the one that collides
   * with the `None` bucket Artifact Analysis really reports.
   */
  for (const blockOn of [['DISABLED'], ['NONE'], ['NONE', 'CRITICAL']]) {
    assert.throws(
      () => declare({ dev: { ...ecrStage('boxlite-backoffice-dev'), scan: { blockOn, timeoutSeconds: 300 } } }),
      /turns the gate off as the whole value, not as an entry/,
      `${JSON.stringify(blockOn)} was not pointed at the right spelling`,
    )
  }

  // The empty array stays refused, and now says what to write instead.
  assert.throws(
    () => declare({ dev: { ...ecrStage('boxlite-backoffice-dev'), scan: { blockOn: [], timeoutSeconds: 300 } } }),
    /must be a non-empty array, or "DISABLED" to block on nothing/,
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

/*
 * The release line.
 *
 * A commit build and the release build of one commit are different bytes, and
 * a stage that admits only released images has to tell them apart from the
 * address alone — so the discriminator lives in the tag rather than in a record
 * beside it.
 */

test('a release build carries the version it was cut at and the commit it was cut from', () => {
  // Both halves. The version alone moves when a release is re-cut, and
  // everything downstream compares an image tag as an identity without looking
  // inside it; the commit alone is already the commit build's own address.
  assert.equal(releaseTagFor({ version: VERSION, sha: SHA }), `${VERSION}-${SHA}`)
  assert.ok(RELEASE_VERSION.test(VERSION))
})

test('a release version is refused unless it is v and a stable X.Y.Z', () => {
  for (const version of ['1.2.3', 'v1.2', 'v1.2.3.4', 'v1.2.3-rc.1', 'V1.2.3', 'v01.2.3', 'release']) {
    assert.throws(() => releaseTagFor({ version, sha: SHA }), ImageAddressError, `${version} was accepted as a version`)
    assert.equal(RELEASE_VERSION.test(version), false, `${version} was accepted as a version`)
  }
})

test('a release names the commit it was cut from, not another release tag', () => {
  // `v1.2.3-v1.2.3-<sha>` passes no shape check downstream and would publish
  // under a name nothing ever looks for.
  assert.throws(() => releaseTagFor({ version: VERSION, sha: `${VERSION}-${SHA}` }), ImageAddressError)
  assert.throws(() => releaseTagFor({ version: VERSION, sha: SHA.toUpperCase() }), /full lowercase SHA/)
})

test('both tags are valid, and the version prefix loosens nothing else', () => {
  assert.equal(assertTag(SHA), SHA)
  assert.equal(assertTag(`${VERSION}-${SHA}`), `${VERSION}-${SHA}`)
  for (const rejected of [
    'v1.2.0',
    `V1.2.3-${SHA}`,
    `1.2.3-${SHA}`,
    `${VERSION}-${'a'.repeat(39)}`,
    `release-${SHA}`,
    `${SHA}-${VERSION}`,
    `${VERSION}-${VERSION}-${SHA}`,
    `v1.2.3-rc.1-${SHA}`,
  ]) {
    assert.throws(() => assertTag(rejected), ImageAddressError, `${rejected} was accepted as a tag`)
  }
})

test('the release tag reaches whichever half of the address carries a tag', () => {
  // Composed in this module rather than by the workflow that asks for one, so
  // the prefix lands correctly on both registries without a caller having to
  // know which half it belongs in.
  const release = releaseTagFor({ version: VERSION, sha: SHA })
  const dev = resolveRegistry({ config, stage: 'dev', region: REGION.dev, accountId: ACCOUNT })
  assert.equal(
    addressFor({ config, registry: dev, artifact: 'api', tag: release }),
    `000000000000.dkr.ecr.ap-southeast-1.amazonaws.com/boxlite-backoffice-dev:${VERSION}-${SHA}-api`,
  )

  const gcp = onArtifactRegistry()
  const registry = resolveRegistry({ config: gcp, stage: 'dev', region: 'asia-southeast1', project: 'boxlite' })
  assert.equal(
    addressFor({ config: gcp, registry, artifact: 'api', tag: release }),
    `asia-southeast1-docker.pkg.dev/boxlite/boxlite-backoffice/api:${VERSION}-${SHA}`,
  )
})

test('one artifact can be addressed without the rest, and a typo cannot', () => {
  // What `--artifact` is: publish, verify and promote all iterate
  // `config.artifacts`, so narrowing the config is what gives each image its
  // own job. An undeclared name has to throw rather than narrow to nothing —
  // an empty set publishes nothing and reports success.
  assert.deepEqual(Object.keys(onlyArtifact(config, 'api').artifacts), ['api'])
  assert.deepEqual(Object.keys(onlyArtifact(config, 'console').artifacts), ['console'])
  assert.deepEqual(Object.keys(config.artifacts), ['console', 'api'], 'narrowing must not mutate the config it read')
  assert.throws(() => onlyArtifact(config, 'proxy'), BuildConfigError)
  assert.throws(() => onlyArtifact(config, 'proxy'), /declares no artifact "proxy"\. Declared: console, api/)
})

test('a name every object inherits is not a name the file declares', () => {
  /*
   * `--artifact` and `--stage` come from argv and are looked up in objects
   * parsed out of JSON, so they carry `Object.prototype` with them. A lookup
   * that reads through it answers "declared" for `toString` and hands back a
   * function: `onlyArtifact` would narrow to an artifact with no Dockerfile,
   * and `addressFor` would compose an address for an image nothing builds —
   * far enough in for `publish` to have created the repository first.
   */
  const registry = resolveRegistry({ config, stage: 'dev', region: REGION.dev, accountId: ACCOUNT })
  for (const inherited of ['toString', 'constructor', 'hasOwnProperty']) {
    assert.throws(
      () => onlyArtifact(config, inherited),
      BuildConfigError,
      `${inherited} narrowed to something the file never declared`,
    )
    assert.throws(
      () => addressFor({ config, registry, artifact: inherited, tag: SHA }),
      ImageAddressError,
      `${inherited} was given an address`,
    )
    assert.throws(() => registryFor(config, inherited), BuildConfigError, `${inherited} resolved to a registry`)
  }
})

test('narrowing changes which images are addressed and nothing about where', () => {
  // The registry belongs to the stage, not to the image, so it has to survive
  // the narrowing — a promotion that lost it would push at the wrong account.
  const narrowed = onlyArtifact(config, 'api')
  assert.deepEqual(registryFor(narrowed, 'prod'), registryFor(config, 'prod'))
  assert.equal(
    addressFor({
      config: narrowed,
      registry: resolveRegistry({ config: narrowed, stage: 'prod', region: REGION.prod, accountId: ACCOUNT }),
      artifact: 'api',
      tag: SHA,
    }),
    `000000000000.dkr.ecr.us-east-1.amazonaws.com/boxlite-backoffice-prod:${SHA}-api`,
  )
})

test('a release build and a commit build of one commit never share an address', () => {
  // The property the prefix exists for: prod can be narrowed to the release
  // line only because the two lines are two addresses.
  const dev = resolveRegistry({ config, stage: 'dev', region: REGION.dev, accountId: ACCOUNT })
  assert.notEqual(
    addressFor({ config, registry: dev, artifact: 'api', tag: SHA }),
    addressFor({ config, registry: dev, artifact: 'api', tag: releaseTagFor({ version: VERSION, sha: SHA }) }),
  )
})
