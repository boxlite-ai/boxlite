import assert from 'node:assert/strict'
import test from 'node:test'
import { NameError, POOL_LIMIT, SERVICE_ACCOUNT_LIMIT, identityFor, instanceFor, poolFor } from '../src/names.ts'

const APP = 'boxlite'
/** What `mstage.env.json` declares beside it, and why: see `names.ts`. */
const SHORT = 'bl-app'

/** The stages `.mstage.config.json` declares. `prod` and `dev2` are the longest. */
const STAGES = ['dev', 'prod', 'dev2']
/** The workloads a stage runs. `otel-collector` is the one the limit is tight for. */
const ARTIFACTS = ['api', 'proxy', 'otel-collector', 'runner']

test('an identity takes the app abbreviated, and the abbreviation is what it was given', () => {
  // Not derived here. `boxlite` is already short enough to look like it needs
  // no abbreviation, so `bl-app` is not a contraction of it — it says which
  // BoxLite thing this is, in a project shared with the rest of them.
  assert.equal(identityFor({ appShort: SHORT, stage: 'dev', artifact: 'api', action: 'run' }), 'bl-app-dev-api-run')
  assert.equal(
    identityFor({ appShort: SHORT, stage: 'prod', artifact: 'otel-collector', action: 'run' }),
    'bl-app-prod-otel-collector-run',
  )
})

test('a segment that does not apply is dropped, not left empty', () => {
  // An empty segment reads as a name with a stutter in it — `bl-app--run` is a
  // different string from every name anything would look for.
  assert.equal(identityFor({ appShort: SHORT, action: 'publish' }), 'bl-app-publish')
  assert.equal(identityFor({ appShort: SHORT, stage: 'dev', action: 'deploy' }), 'bl-app-dev-deploy')
  assert.equal(identityFor({ appShort: SHORT, stage: 'dev' }), 'bl-app-dev')
})

test('nothing marks an identity as one; the abbreviation is what tells them apart', () => {
  // Two forms, no prefix. The pair below is what a project holds for one
  // workload, and neither could be read as the other.
  assert.equal(identityFor({ appShort: SHORT, stage: 'dev', artifact: 'api', action: 'run' }), 'bl-app-dev-api-run')
  assert.equal(instanceFor({ app: APP, stage: 'dev', artifact: 'api' }), 'boxlite-dev-api')
})

test('every name this repository creates fits what GCP accepts', () => {
  // The reason the abbreviation exists, and the margin it buys: the longest
  // name below lands on 30 exactly, so every stage and every artifact is
  // checked rather than the one that looks worst.
  for (const stage of STAGES) {
    for (const artifact of ARTIFACTS) {
      const name = identityFor({ appShort: SHORT, stage, artifact, action: 'run' })
      assert.ok(name.length <= SERVICE_ACCOUNT_LIMIT, `${name} is ${name.length}`)
    }
    // The identity mdeploy runs as: one per stage, no workload of its own.
    assert.ok(identityFor({ appShort: SHORT, stage, action: 'deploy' }).length <= SERVICE_ACCOUNT_LIMIT)
  }
  // The image publisher and the pool that trusts GitHub serve every stage, so
  // neither carries one.
  assert.ok(identityFor({ appShort: SHORT, action: 'publish' }).length <= SERVICE_ACCOUNT_LIMIT)
  assert.ok(poolFor({ appShort: SHORT }).length <= POOL_LIMIT)
})

test('a name too long is refused here rather than by gcloud halfway through a bootstrap', () => {
  // What the app spelled out would have produced, on the one workload where it
  // matters: over by a single character. Refused with the number in it, because
  // "invalid argument" from gcloud says nothing about which segment.
  const spelledOut = { appShort: APP, stage: 'prod', artifact: 'otel-collector', action: 'run' }
  assert.throws(() => identityFor(spelledOut), NameError)
  assert.throws(() => identityFor(spelledOut), /is 31 characters and the limit is 30/)
})

test('a pool has its own limit, which is two characters looser', () => {
  assert.equal(POOL_LIMIT - SERVICE_ACCOUNT_LIMIT, 2)
  assert.equal(poolFor({ appShort: SHORT, stage: 'prod', artifact: 'publishers' }), 'bl-app-prod-publishers')

  /*
   * The band where the two limits diverge, checked on one name rather than on
   * two: the same segments through both functions differ only by which limit
   * they are held against, so 31 and 32 are accepted as a pool and refused as
   * a service account. Built to land in that band — a name short enough for
   * both, or long enough for neither, would leave the two characters between
   * them untested and this test asserting nothing about the difference.
   */
  for (const appShort of ['boxlite-app', 'boxlite-apps']) {
    const segments = { appShort, stage: 'prod', artifact: 'otel-collector' }
    const name = poolFor(segments)
    assert.ok(
      name.length > SERVICE_ACCOUNT_LIMIT && name.length <= POOL_LIMIT,
      `${name} is ${name.length}, which is outside the band this case exists for`,
    )
    assert.throws(() => identityFor(segments), NameError)
    assert.throws(() => identityFor(segments), new RegExp(`is ${name.length} characters and the limit is 30`))
  }
})

test('an instance takes the app in full, and drops the artifact it has none of', () => {
  // No length budget here — Cloud Run takes 49 — and the full name is what a
  // person reading a console sees.
  assert.equal(instanceFor({ app: APP, stage: 'dev', artifact: 'otel-collector' }), 'boxlite-dev-otel-collector')
  assert.equal(instanceFor({ app: APP, stage: 'dev' }), 'boxlite-dev')
})
