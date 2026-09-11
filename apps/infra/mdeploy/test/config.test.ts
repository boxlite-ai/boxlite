import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DeployConfigError, parseDeployConfig } from '../src/config.ts'

const valid = {
  database: { name: 'boxlite', size: 'small', highlyAvailable: false, backupRetentionDays: 7, protected: false },
  cache: { size: 'small', clustered: false, encryptInTransit: true },
  storage: { volumePrefix: 'boxlite-volume', versioning: true },
  clickhouse: {
    mode: 'self-hosted',
    database: 'otel',
    writerUsername: 'otel_writer',
    readerUsername: 'otel_reader',
    instanceSize: 'medium',
    dataGb: 50,
  },
  runners: { size: 'large', rootDiskGb: 100 },
  alarms: {
    apiServerErrors: { threshold: 1, periods: 1 },
    proxyUnhealthyTargets: { threshold: 1, periods: 2 },
    runnersUnreachable: { threshold: 1, periods: 3 },
  },
}

const parse = (overrides: Record<string, unknown> = {}) =>
  parseDeployConfig('/repo/apps/infra/mdeploy.config.json', JSON.stringify({ ...valid, ...overrides }))

test('the defaults have to be complete, because nothing else supplies them', () => {
  // A stage says only what differs, so a gap there is the point. A gap in the
  // defaults is a value nothing supplies, and the resource would be created
  // from whatever the provider happened to default to.
  const { database, ...withoutDatabase } = valid
  assert.throws(
    () => parseDeployConfig('/repo/mdeploy.config.json', JSON.stringify(withoutDatabase)),
    /"database" must be an object/,
  )
  assert.throws(() => parse({ runners: { size: 'large' } }), /"runners" must set rootDiskGb/)
})

test('an unencrypted cache is refused rather than accepted and overridden', () => {
  // Accepting it and quietly turning encryption on would read as if the setting
  // worked. The cache carries sessions and box credentials across a network
  // every workload shares.
  assert.throws(() => parse({ cache: { ...valid.cache, encryptInTransit: false } }), /cannot be false/)
})

test('the two ClickHouse accounts must differ', () => {
  // One credential for both would let a compromised read path rewrite the
  // history it is reading, which is the whole reason there are two.
  assert.throws(
    () => parse({ clickhouse: { ...valid.clickhouse, readerUsername: 'otel_writer' } }),
    /writerUsername and readerUsername must differ/,
  )
})

test('a volume prefix that is not a bucket name on both clouds is refused', () => {
  // The prefix bounds what the API may delete, so a value two clouds could read
  // two ways is not one to accept.
  assert.throws(() => parse({ storage: { volumePrefix: 'BoxLite_Volume', versioning: true } }), /must match/)
  assert.throws(() => parse({ storage: { volumePrefix: 'x', versioning: true } }), /must match/)
})

test('a size no provider answers to is refused here rather than at the apply', () => {
  assert.throws(() => parse({ database: { ...valid.database, size: 'enormous' } }), /must be one of small, medium/)
  assert.throws(() => parse({ runners: { size: 'tiny', rootDiskGb: 100 } }), /must be one of small, medium, large/)
})

test('a key nothing reads is refused, so a typo is not silently inert', () => {
  assert.throws(() => parse({ database: { ...valid.database, retention: 7 } }), /does not take retention/)
  assert.throws(() => parse({ databse: {} }), /does not take databse/)
  /*
   * `stages` is the old shape: defaults at the top level and per-stage
   * overrides beneath them, in a file of mdeploy's own. A block pasted from one
   * would parse as the defaults and drop every per-stage value silently, so the
   * key is refused rather than ignored — the stage a block belongs to is now
   * the stage it is written inside.
   */
  assert.throws(() => parse({ stages: { dev: {} } }), /does not take stages/)
})

test('DeployConfigError is the single failure type callers can catch', () => {
  assert.throws(
    () => parse({ database: { ...valid.database, size: 'enormous' } }),
    (error) => error instanceof DeployConfigError,
  )
})

/**
 * Every stage's block, read out of the committed example.
 *
 * `.mstage.config.example.json` rather than `.mstage.config.json`: the real one
 * names somebody's cloud account and is not committed, so this is the only copy
 * a fresh checkout and CI have. Reading it here is also what keeps it usable —
 * it is copied before it is read, so an example that no longer parses is worse
 * than none.
 */
const declared = (() => {
  const path = new URL('../../.mstage.config.example.json', import.meta.url)
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { stages: Record<string, { deploy?: unknown }> }
  return { path: path.pathname, stages: raw.stages }
})()

const blockFor = (stage: string) =>
  parseDeployConfig(`${declared.path}: stage "${stage}" deploy`, JSON.stringify(declared.stages[stage]?.deploy ?? {}))

test('every stage this repository declares carries a complete, parseable block', () => {
  /*
   * The property that replaced "a stage is an override": there are no
   * repository-wide defaults any more, so a stage added without a block is not
   * a stage that deploys the usual shape — it is a stage that cannot deploy.
   * The failure without this is a parse error at the apply, after the stage was
   * already reachable from CI.
   */
  const stages = Object.keys(declared.stages)
  assert.ok(stages.length > 0, `${declared.path} declares no stage`)
  for (const stage of stages) {
    const block = blockFor(stage)
    assert.equal(block.database.name, 'boxlite', `${stage} names another database`)
    assert.ok(block.runners.rootDiskGb > 0, `${stage} sizes no runner disk`)
  }
})

test('the stages differ where they are meant to, and each says so in full', () => {
  // Read from the blocks rather than from a diff against defaults, because
  // there are none: what makes prod prod is written in prod.
  assert.equal(blockFor('prod').database.protected, true, 'production refuses deletion')
  assert.equal(blockFor('prod').database.highlyAvailable, true)
  assert.equal(blockFor('prod').cache.size, 'medium')
  assert.equal(blockFor('dev').database.protected, false, 'dev is deletable')
  assert.equal(blockFor('dev2').clickhouse.mode, 'disabled')
  assert.equal(blockFor('dev2').runners.size, 'small', 'the GCP stage runs a smaller fleet than AWS dev')
  assert.equal(blockFor('dev').storage.versioning, true)
  assert.equal(blockFor('dev').runners.rootDiskGb, 100)
  assert.equal(blockFor('dev').runners.size, 'large', 'a runner has to be a machine family that can nest')
})
