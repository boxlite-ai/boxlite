// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { STORABLE_STAGE_CONFIG_KEYS, isStorableStageConfigKey } from './storable-keys.js'
import { isLocalOnlyDeploymentKey } from './validate-environment.js'
import { liveText } from '../shared/live-source.js'
import { CLICKHOUSE_STAGE_CONFIG_KEYS } from '../scripts/clickhouse-config.mjs'

const INFRA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Where a deploy resolves configuration. Test files are excluded: they set synthetic values, they do
// not define what a deploy reads.
const SCANNED = ['stack', 'deployment', 'artifacts', 'runner', 'shared']
/*
 * Direct reads only. A name handed to a helper that reads it — `runnerEndpoint('DEFAULT_RUNNER_DOMAIN',
 * …)`, which forwards to envOr — is deliberately not matched.
 *
 * Widening this to follow that indirection was tried and reverted. It surfaces DEFAULT_RUNNER_DOMAIN,
 * _API_URL and _PROXY_URL, which the stack does pass to the API, but the API consumes them only on the
 * v0 runner path: DEFAULT_RUNNER_API_VERSION defaults to '2', is not storable, and is not set by the
 * stack, so no deployed stage can reach v0. Allowlisting them would widen what the shared store may
 * carry while changing nothing a stage can observe.
 *
 * If a stage ever becomes able to select v0, this pattern and that list both need revisiting together.
 */
const ENV_READ =
  /envOr\(\s*'([A-Z][A-Z0-9_]*)'|requireEnv\(\s*'([A-Z][A-Z0-9_]*)'|process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[\s*'([A-Z][A-Z0-9_]*)'\s*\]|environment\.([A-Z][A-Z0-9_]*)/g

function sourceFiles(directory: string): string[] {
  const root = join(INFRA_ROOT, directory)
  const found: string[] = []
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(join(directory, entry)))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      found.push(path)
    }
  }
  return found
}

function keysReadFromSource() {
  const keys = new Set<string>()
  for (const directory of SCANNED) {
    for (const path of sourceFiles(directory)) {
      // Comments stripped first. A doc comment writing `process.env.X` to explain a pattern is prose,
      // and scanning it put a key named X in the allowlist — the repo already has liveText for exactly
      // this distinction.
      for (const match of liveText('script', readFileSync(path, 'utf8')).matchAll(ENV_READ)) {
        const key = match.slice(1).find(Boolean)
        if (key) keys.add(key)
      }
    }
  }
  for (const key of CLICKHOUSE_STAGE_CONFIG_KEYS) keys.add(key)
  return keys
}

test('the allowlist is exactly what the deploy reads, minus what must stay local', () => {
  // The property that makes an allowlist worth having: it cannot drift from the code silently. Adding
  // an `envOr('NEW_THING', …)` to the stack fails here until NEW_THING is added to the list, which is
  // what turns "widen what a store may inject" into a decision rather than a side effect.
  const expected = [...keysReadFromSource()].filter((key) => !isLocalOnlyDeploymentKey(key)).sort()
  assert.deepEqual([...STORABLE_STAGE_CONFIG_KEYS].sort(), expected)
})

test('nothing the deploy never reads can be hydrated', () => {
  // Known vectors in the denylist this replaces. None is read by the
  // stack, so none is storable — and, unlike the denylist, an eighth nobody has thought of is refused
  // by the same rule rather than needing to be named.
  const vectors = [
    'NODE_OPTIONS',
    'BASH_ENV',
    'GIT_SSH_COMMAND',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'LD_AUDIT',
    'LD_PRELOAD',
    'SST_BUN_PATH',
    'SST_PULUMI_PATH',
    'BUN_OPTIONS',
    'GH_TOKEN',
    'RUSTC_WRAPPER',
    'SSH_ASKPASS',
    'PULUMI_CONFIG_PASSPHRASE',
    'GIT_CONFIG_GLOBAL',
    // Nobody has proposed this one; it is refused because it is unknown, which is the point.
    'SOME_KEY_NOBODY_HAS_THOUGHT_OF',
  ]
  for (const key of vectors) {
    assert.equal(isStorableStageConfigKey(key), false, `${key} must not be storable`)
  }
})

test('the configuration a stage actually needs is storable', () => {
  // The other half: an allowlist that refused real configuration would be useless. These are the keys
  // .env.example marks required.
  for (const key of ['STACK_DOMAIN', 'OIDC_AUDIENCE', 'OIDC_ISSUER_BASE_URL', 'IAM_PERMISSIONS_BOUNDARY_STAGE']) {
    assert.equal(isStorableStageConfigKey(key), true, `${key} must be storable`)
  }
})

test('a key that is both read by the stack and dangerous is still refused', () => {
  // stack/app.ts reads AWS_PROFILE, so the source scan finds it — the denylist is what keeps it out.
  // This is why that list survives as a second check rather than being deleted.
  assert.equal(keysReadFromSource().has('AWS_PROFILE'), true, 'the scan should see it')
  assert.equal(isStorableStageConfigKey('AWS_PROFILE'), false, 'and it must still be refused')
})
