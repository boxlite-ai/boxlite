// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  STAGE_CONFIG_MANIFEST_KEY,
  readStoredStageConfig,
  hydrateStageConfig,
  parseSecretList,
  parseStageConfigManifest,
  serializeStageConfigManifest,
} from './stage-config.js'

// The shape `sst secret list` prints: a fallback section, then the stage's own.
const SECRET_LIST = [
  '# fallback',
  'STACK_DOMAIN=fallback.boxlite.ai',
  'OIDC_AUDIENCE=https://fallback.boxlite.ai/api',
  '# boxlite/dev',
  'STACK_DOMAIN=dev.boxlite.ai',
  `${STAGE_CONFIG_MANIFEST_KEY}=OIDC_AUDIENCE,STACK_DOMAIN`,
  '',
].join('\n')

test('parseSecretList prefers the stage section over the fallback section', () => {
  const stored = parseSecretList(SECRET_LIST, { app: 'boxlite', stage: 'dev' })
  // STACK_DOMAIN is set in both; the stage value is the one `sst deploy` would use.
  assert.equal(stored.STACK_DOMAIN, 'dev.boxlite.ai')
  // OIDC_AUDIENCE is only a fallback, so it still resolves.
  assert.equal(stored.OIDC_AUDIENCE, 'https://fallback.boxlite.ai/api')
})

test('parseSecretList resolves by section header, not by line order', () => {
  // The same two entries with the stage section FIRST. A last-wins parse would hand back the
  // fallback value here, which is not what a deploy of this stage would use.
  const reordered = ['# boxlite/dev', 'STACK_DOMAIN=dev.boxlite.ai', '# fallback', 'STACK_DOMAIN=fallback.boxlite.ai'].join('\n')
  assert.equal(parseSecretList(reordered, { app: 'boxlite', stage: 'dev' }).STACK_DOMAIN, 'dev.boxlite.ai')
})

test('parseSecretList ignores another stage section entirely', () => {
  const other = ['# boxlite/prod', 'STACK_DOMAIN=boxlite.ai', '# boxlite/dev', 'STACK_DOMAIN=dev.boxlite.ai'].join('\n')
  assert.deepEqual(parseSecretList(other, { app: 'boxlite', stage: 'dev' }), { STACK_DOMAIN: 'dev.boxlite.ai' })
})

test('parseSecretList treats an empty store as empty, not as a parse error', () => {
  // What sst prints when nothing is set; a stage mid-bootstrap must not fail here.
  assert.deepEqual(parseSecretList('No secrets found\n', { app: 'boxlite', stage: 'dev' }), {})
  assert.deepEqual(parseSecretList('', { app: 'boxlite', stage: 'dev' }), {})
  assert.deepEqual(parseSecretList(undefined, { app: 'boxlite', stage: 'dev' }), {})
})

test('parseSecretList keeps a value containing the separator and trailing content', () => {
  const stored = parseSecretList(
    ['# boxlite/dev', 'BOXLITE_SYSTEM_IMAGES=base=ghcr.io/acme/base:v1,py=ghcr.io/acme/py:v1', 'EMPTY='].join('\n'),
    { app: 'boxlite', stage: 'dev' },
  )
  assert.equal(stored.BOXLITE_SYSTEM_IMAGES, 'base=ghcr.io/acme/base:v1,py=ghcr.io/acme/py:v1')
  assert.equal(stored.EMPTY, '')
})

test('hydrateStageConfig applies only the keys the manifest names', () => {
  const { apply, unlisted } = hydrateStageConfig({
    stored: {
      [STAGE_CONFIG_MANIFEST_KEY]: 'STACK_DOMAIN,OIDC_AUDIENCE',
      STACK_DOMAIN: 'dev.boxlite.ai',
      OIDC_AUDIENCE: 'https://dev.boxlite.ai/api',
      // A key .env once defined and no longer does: `sst secret load` merges, so it is still in the
      // store. Off the manifest, so it must not reach the deploy.
      PROXY_DOMAIN: 'stale.boxlite.ai',
      // A hand-set `sst secret set OIDC_CLIENT_ID` — the stack reads this through sst.Secret, not
      // process.env, so hydrating it would be wrong as well as unnecessary.
      OIDC_CLIENT_ID: 'synthetic-client-id',
    },
    environment: {},
  })

  assert.deepEqual(apply, { OIDC_AUDIENCE: 'https://dev.boxlite.ai/api', STACK_DOMAIN: 'dev.boxlite.ai' })
  assert.deepEqual(unlisted, ['OIDC_CLIENT_ID', 'PROXY_DOMAIN'])
})

test('hydrateStageConfig lets a variable already in the environment win', () => {
  const { apply, alreadySet } = hydrateStageConfig({
    stored: {
      [STAGE_CONFIG_MANIFEST_KEY]: 'STACK_DOMAIN,BOXLITE_SYSTEM_IMAGE_TAG',
      STACK_DOMAIN: 'dev.boxlite.ai',
      BOXLITE_SYSTEM_IMAGE_TAG: 'v0.1.0',
    },
    // What the deploy workflow sets on the job. A stored value must never override it.
    environment: { BOXLITE_SYSTEM_IMAGE_TAG: 'v9.9.9' },
  })

  assert.deepEqual(apply, { STACK_DOMAIN: 'dev.boxlite.ai' })
  assert.deepEqual(alreadySet, ['BOXLITE_SYSTEM_IMAGE_TAG'])
})

test('hydrateStageConfig honours an empty environment variable as deliberately set', () => {
  // '' is how a consumer is told "unset" (envOr and requireEnv both treat it as falsy), so an
  // operator who exported KEY= meant to suppress the stored value, not to fall through to it.
  const { apply, alreadySet } = hydrateStageConfig({
    stored: { [STAGE_CONFIG_MANIFEST_KEY]: 'APP_URL', APP_URL: 'https://stored.example' },
    environment: { APP_URL: '' },
  })
  assert.deepEqual(apply, {})
  assert.deepEqual(alreadySet, ['APP_URL'])
})

test('parseSecretList keeps a value\'s leading and trailing spaces', () => {
  // sst prints `key + "=" + value` with nothing added, so every character after the first `=` is the
  // value. Trimming the line would silently delete padding that serializeStageConfig went out of its
  // way to preserve, and the corruption would only show up in a deployed container's environment.
  const stored = parseSecretList(['# boxlite/dev', 'PADDED=  spaced out  ', 'TRAILING_TAB=value\t'].join('\n'), {
    app: 'boxlite',
    stage: 'dev',
  })
  assert.equal(stored.PADDED, '  spaced out  ')
  assert.equal(stored.TRAILING_TAB, 'value\t')
})

test('hydrateStageConfig never applies a key consulted before the store is reachable', () => {
  // CLOUDFLARE_* is needed in order to read the store at all, AWS_REGION is resolved before it, and
  // SST_STAGE chooses which store to read. A stored copy of any of them could only disagree with the
  // value actually used, so hydration must drop it even though bootstrap already keeps it out.
  const guarded = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_DEFAULT_ACCOUNT_ID', 'AWS_REGION', 'SST_STAGE', 'VERSION']
  const { apply, unlisted } = hydrateStageConfig({
    stored: {
      [STAGE_CONFIG_MANIFEST_KEY]: [...guarded, 'STACK_DOMAIN'].join(','),
      ...Object.fromEntries(guarded.map((key) => [key, 'synthetic'])),
      STACK_DOMAIN: 'dev.boxlite.ai',
    },
    environment: {},
  })
  assert.deepEqual(apply, { STACK_DOMAIN: 'dev.boxlite.ai' })
  assert.deepEqual(unlisted, [...guarded].sort())
})

test('hydrateStageConfig refuses a forbidden key even when the manifest names it', () => {
  // Defence in depth behind bootstrap's filter: the manifest is itself a store entry, so a writer
  // who can set a secret can also name it. Neither local credential context nor an artifact
  // selector may become stage-wide configuration.
  const forbidden = ['AWS_PROFILE', 'AWS_CLI_PATH', 'AWS_ENDPOINT_URL_S3', 'BOXLITE_ARTIFACT_SOURCE', 'SST_BIN_PATH']
  const { apply, unlisted } = hydrateStageConfig({
    stored: {
      [STAGE_CONFIG_MANIFEST_KEY]: [...forbidden, 'STACK_DOMAIN'].join(','),
      ...Object.fromEntries(forbidden.map((key) => [key, 'synthetic'])),
      STACK_DOMAIN: 'dev.boxlite.ai',
    },
    environment: {},
  })

  assert.deepEqual(apply, { STACK_DOMAIN: 'dev.boxlite.ai' })
  assert.deepEqual(unlisted, [...forbidden].sort())
})

test('hydrateStageConfig never applies the manifest itself', () => {
  const { apply } = hydrateStageConfig({
    stored: { [STAGE_CONFIG_MANIFEST_KEY]: `STACK_DOMAIN,${STAGE_CONFIG_MANIFEST_KEY}`, STACK_DOMAIN: 'dev.boxlite.ai' },
    environment: {},
  })
  assert.deepEqual(Object.keys(apply), ['STACK_DOMAIN'])
})

test('hydrateStageConfig applies nothing when the manifest is absent', () => {
  // A stage bootstrapped before the manifest existed: fail closed rather than hydrate everything
  // the store happens to hold.
  const { apply, unlisted } = hydrateStageConfig({
    stored: { STACK_DOMAIN: 'dev.boxlite.ai', OIDC_CLIENT_ID: 'synthetic' },
    environment: {},
  })
  assert.deepEqual(apply, {})
  assert.deepEqual(unlisted, ['OIDC_CLIENT_ID', 'STACK_DOMAIN'])
})

test('the manifest round-trips through serialize and parse', () => {
  assert.equal(serializeStageConfigManifest(['STACK_DOMAIN', 'OIDC_AUDIENCE', 'STACK_DOMAIN']), 'OIDC_AUDIENCE,STACK_DOMAIN')
  assert.deepEqual(parseStageConfigManifest('OIDC_AUDIENCE,STACK_DOMAIN'), ['OIDC_AUDIENCE', 'STACK_DOMAIN'])
  assert.deepEqual(parseStageConfigManifest(' A , , B '), ['A', 'B'])
  assert.deepEqual(parseStageConfigManifest(undefined), [])
  assert.equal(serializeStageConfigManifest([]), '')
})

test('readStoredStageConfig reads the stage it was asked for', () => {
  const calls: any[] = []
  const stored = readStoredStageConfig({
    app: 'boxlite',
    stage: 'dev',
    runSst: (args: any) => {
      calls.push(args)
      return SECRET_LIST
    },
  })

  assert.deepEqual(calls, [['secret', 'list', '--stage', 'dev']])
  assert.equal(stored.STACK_DOMAIN, 'dev.boxlite.ai')
})

test('readStoredStageConfig refuses to run without a runner, app, or stage', () => {
  assert.throws(() => readStoredStageConfig({ app: 'boxlite', stage: 'dev' }), /requires a runSst function/)
  assert.throws(() => readStoredStageConfig({ runSst: () => '', stage: 'dev' }), /requires an app and a stage/)
  assert.throws(() => readStoredStageConfig({ runSst: () => '', app: 'boxlite' }), /requires an app and a stage/)
})
