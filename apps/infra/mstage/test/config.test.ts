import assert from 'node:assert/strict'
import test from 'node:test'
import { ConfigError, homeFor, parseBase, parseConfig, parseStages } from '../src/config/load.ts'

const base = { app: 'boxlite-backoffice' }
const declared = {
  dev: { home: 'aws', region: 'ap-southeast-1' },
  prod: { home: 'aws', region: 'ap-southeast-1', protect: true },
}

/** Both halves, so a test can override either without spelling out the other. */
const parse = (overrides: any = {}) => {
  const { stages, ...rest } = overrides
  return parseConfig({
    basePath: '/repo/mstage.env.json',
    base: JSON.stringify({ ...base, ...rest }),
    stagePath: '/repo/.mstage.config.json',
    stages: JSON.stringify({ stages: stages ?? declared }),
  })
}

test('a complete config keeps every declared stage field', () => {
  const config = parse({})
  assert.equal(config.app, 'boxlite-backoffice')
  assert.equal(config.root, '/repo')
  assert.deepEqual(config.stages.dev, {
    region: 'ap-southeast-1',
    home: 'aws',
    login: {},
    project: null,
    zone: null,
    roleArn: null,
    protect: false,
    deploy: {},
  })
  assert.equal(config.stages.prod.protect, true)
})

test('a stage may pin the zone its machines are created in', () => {
  // Not decoration: a machine family is stocked per zone, and the region's first
  // is the one a derived value would always pick. `asia-southeast1-a` refuses an
  // N4 with `stockout` while `-b` creates one, so a stage that cannot say which
  // zone it wants is a stage that cannot be deployed.
  const config = parse({
    stages: { dev: { region: 'asia-southeast1', home: 'gcp', project: 'p', zone: 'asia-southeast1-b' } },
  })
  assert.equal(config.stages.dev!.zone, 'asia-southeast1-b')
  // Silence still means the region's first, which is resolved where it is used
  // rather than written in here — a stage with nothing to say about placement
  // should not have to say it.
  assert.equal(parse({ stages: { dev: { home: 'aws', region: 'ap-southeast-1' } } }).stages.dev!.zone, null)
})

test('each stage says which cloud it is in, and two clouds sit in one file', () => {
  // The AWS stages are in service while a GCP one is brought up beside them,
  // and both have to be deployable from one checkout.
  const config = parse({
    stages: {
      dev: { home: 'aws', region: 'ap-southeast-1' },
      'gcp-dev': { home: 'gcp', region: 'asia-southeast1', project: 'boxlite-gcp-dev' },
    },
  })
  assert.equal(homeFor(config, 'dev'), 'aws')
  assert.equal(homeFor(config, 'gcp-dev'), 'gcp')
})

test('a stage that lives in gcp must name its project', () => {
  // The clients cannot be built without a project, and the stage file is the
  // only thing that could supply one.
  assert.throws(
    () => parse({ stages: { dev: { region: 'asia-southeast1', home: 'gcp' } } }),
    /lives in gcp and must declare a project/,
  )
})

test('homeFor refuses a stage the config never declared rather than guessing the default', () => {
  assert.throws(() => homeFor(parse({}), 'dve'), /declares no stage "dve"\. Declared: dev, prod/)
})

test('a GCP stage declares the project it lives in; an AWS stage declares no tenant at all', () => {
  // The AWS account is read back from the credentials by whoever has to name it
  // in an ARN, so there is nothing here to keep in step with it. GCP's clients
  // cannot be built without a project, so that one is declared.
  const config = parse({ stages: { dev: { home: 'gcp', region: 'asia-southeast1', project: 'boxlite-dev' } } })
  assert.equal(config.stages.dev!.project, 'boxlite-dev')
  assert.equal(parse({}).stages.dev!.project, null)
})

test("how a stage deploys is not the shared config's business", () => {
  // The base file describes the repository, not one deploy of it, so a "deploy"
  // key at its top level must not become a silent contract. The per-stage block
  // below is the one place mdeploy is declared.
  const config = parse({ deploy: { command: ['npm', 'run', 'deploy'] } })
  assert.equal((config as Record<string, unknown>).deploy, undefined)
})

test("a stage's deploy block is carried for mdeploy, and read by nothing here", () => {
  // mdeploy's half of the same block. It rides in the stage file rather than a
  // file of its own for the reason `registry` does: a stage is declared once,
  // and `config put` carries the whole block to a runner in one variable.
  const shape = { service: 'console', cpu: '1', scaling: { min: 0, max: 4 } }
  const config = parse({ stages: { dev: { home: 'aws', region: 'ap-southeast-1', deploy: shape } } })
  assert.deepEqual(config.stages.dev!.deploy, shape, 'every key inside it stays mdeploy\'s to name')

  // Empty is the ordinary state of a stage mdeploy has not been pointed at
  // yet, and so is saying nothing: one shape either way, so a consumer needs
  // no absent case.
  assert.deepEqual(parse({ stages: { dev: { home: 'aws', deploy: {} } } }).stages.dev!.deploy, {})
  assert.deepEqual(parse({}).stages.dev!.deploy, {})

  // Shape is all mstage checks — but a list or a string is not a block of
  // settings, and mdeploy would read it as one.
  assert.throws(
    () => parse({ stages: { dev: { home: 'aws', deploy: ['npm', 'run', 'deploy'] } } }),
    /stage "dev" deploy must be an object/,
  )
  assert.throws(
    () => parse({ stages: { dev: { home: 'aws', deploy: 'cloud-run' } } }),
    /stage "dev" deploy must be an object/,
  )
})

test('malformed JSON names the file that has to be fixed', () => {
  // Two files now, and the refusal has to say which one: they are edited by
  // different people, and one of them is not even committed.
  assert.throws(() => parseBase('/repo/mstage.env.json', '{'), /\/repo\/mstage\.env\.json is not valid JSON/)
  assert.throws(
    () => parseStages('/repo/.mstage.config.json', '{'),
    /\/repo\/\.mstage\.config\.json is not valid JSON/,
  )
})

test('a missing app, a stage with no home and an empty stage map are rejected', () => {
  assert.throws(() => parse({ app: '' }), /"app" must be a non-empty string/)
  assert.throws(() => parse({ stages: {} }), /must declare at least one stage/)
  // No repository-wide default to fall back on: a stage says which cloud it
  // is in, or it is not a stage.
  assert.throws(
    () => parse({ stages: { dev: { region: 'ap-southeast-1' } } }),
    /must declare home as "aws" or "gcp"/,
  )
  assert.throws(() => parse({ stages: { dev: { home: 'cloudflare' } } }), /must declare home as "aws" or "gcp"/)
})

test('the app abbreviation is declared, and falls back to the app itself', () => {
  /*
   * Declared rather than derived. `boxlite-backoffice` shortens to `bl-bo` by
   * the initials of the words inside each word, and `box`+`lite` is a split a
   * person knows and an algorithm does not: every mechanical rule gives some
   * other answer — first letters `bb`, first two `bo-ba`.
   */
  assert.equal(parseBase('/repo/mstage.env.json', JSON.stringify({ app: 'boxlite-backoffice', appShort: 'bl-bo' })).appShort, 'bl-bo')
  // Absent is the ordinary state of a repository whose app is already short,
  // so a consumer reads the same field either way rather than checking.
  assert.equal(parseBase('/repo/mstage.env.json', JSON.stringify({ app: 'payments' })).appShort, 'payments')
})

test('an abbreviation no cloud would accept as a name is refused here', () => {
  // It becomes the first segment of a resource name on both clouds, which is
  // a letter and then letters, digits or `-`. Refused at load rather than by
  // gcloud partway through a bootstrap.
  const short = (appShort: unknown) =>
    parseBase('/repo/mstage.env.json', JSON.stringify({ app: 'boxlite-backoffice', appShort }))
  assert.throws(() => short('BL-BO'), /"appShort" "BL-BO" must match/)
  assert.throws(() => short('1bl'), /"appShort" "1bl" must match/)
  assert.throws(() => short('bl_bo'), /"appShort" "bl_bo" must match/)
  assert.throws(() => short(''), /"appShort" must be a non-empty string/)
  assert.throws(() => short(5), /"appShort" must be a non-empty string/)
})

test('a stage name SST would reject is refused before it can reach the bucket', () => {
  assert.throws(() => parse({ stages: { 'pr/42': { home: 'aws' } } }), /may only contain letters/)
  assert.throws(() => parse({ stages: { staging_2: { home: 'aws' } } }), /may only contain letters/)
})

test('a malformed project, protect flag and login block are rejected', () => {
  assert.throws(() => parse({ stages: { dev: { home: 'aws', project: '  ' } } }), /project must be a non-empty string/)
  assert.throws(() => parse({ stages: { dev: { home: 'aws', protect: 'yes' } } }), /protect must be true or false/)
  assert.throws(
    () => parse({ stages: { dev: { home: 'aws', login: { gcp: { required: 'yes' } } } } }),
    /login "gcp" required must be true or false/,
  )
})

test('a stage declares what reaching it costs, and nothing is inherited', () => {
  // The whole point of folding login into the stage: a GCP stage names no AWS
  // credential, so nothing above it can make one required.
  const config = parse({
    stages: {
      dev: { home: 'aws', region: 'ap-southeast-1', login: { aws: {}, github: { required: false } } },
      'gcp-dev': { home: 'gcp', region: 'asia-southeast1', project: 'p', login: { gcp: {} } },
    },
  })
  assert.deepEqual(config.stages.dev!.login, { aws: { required: true }, github: { required: false } })
  assert.deepEqual(config.stages['gcp-dev']!.login, { gcp: { required: true } })
})

test('ConfigError is the single failure type callers can catch', () => {
  assert.throws(
    () => parse({ app: '' }),
    (error) => error instanceof ConfigError,
  )
})
