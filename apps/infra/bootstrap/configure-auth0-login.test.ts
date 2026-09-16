// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/*
 * The scope refusal is wired in the entrypoint, so it is exercised the way an
 * operator reaches it: a real process, a real Auth0 CLI config, real argv.
 * missingLoginPolicyScopes is unit-tested next door — what only a run can show
 * is that the gate is apply-only and that it lands before the first Auth0
 * call, neither of which a unit test of the predicate would notice.
 */
const infraRoot = fileURLToPath(new URL('..', import.meta.url))
const ENTRYPOINT = 'bootstrap/configure-auth0-login.ts'
const TENANT = 'tenant.us.auth0.com'

/**
 * Every read scope held and the Forms/Flows writes absent: the session shape
 * that created the M2M client and its grant, then stopped at the first Form.
 *
 * Non-empty on purpose — an empty list is the non-interactive session, which
 * is deliberately never refused, so it cannot show which runs are gated.
 */
function sessionWithoutFormsAndFlowsWrites(): string[] {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  return packageJson.scripts['auth0:login-policy-login']
    .split('--scopes ')[1]
    .split(',')
    .filter((scope: string) => !/^(?:create|update|delete):(?:forms|flows|flows_vault_connections)$/.test(scope))
}

/**
 * A home directory holding one CLI session, plus an `auth0` on PATH that
 * records every invocation instead of reaching Auth0. The marker file is the
 * evidence: a gate that ran too late would have called the real CLI first.
 */
function harness(scopes: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'boxlite-auth0-gate-'))
  mkdirSync(join(home, '.config', 'auth0'), { recursive: true })
  writeFileSync(join(home, '.config', 'auth0', 'config.json'), JSON.stringify({ tenants: { [TENANT]: { scopes } } }))

  const binDirectory = join(home, 'bin')
  mkdirSync(binDirectory)
  const invocations = join(home, 'auth0-invocations')
  const fake = join(binDirectory, 'auth0')
  writeFileSync(fake, `#!/bin/sh\necho "$@" >> ${JSON.stringify(invocations)}\necho '[]'\n`)
  chmodSync(fake, 0o755)

  return { home, invocations, binDirectory }
}

function runConfigureLogin(scopes: string[], extraArgs: string[]) {
  const { home, invocations, binDirectory } = harness(scopes)
  try {
    const result = spawnSync(
      'npx',
      ['tsx', ENTRYPOINT, '--tenant', TENANT, '--client-id', 'spa_123', '--connection', 'boxlite-users', ...extraArgs],
      {
        cwd: infraRoot,
        encoding: 'utf8',
        env: { ...process.env, HOME: home, PATH: `${binDirectory}:${process.env.PATH ?? ''}` },
      },
    )
    return { ...result, reachedAuth0: existsSync(invocations) }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('login-policy apply refuses a deficient CLI session before it reaches Auth0', () => {
  const refused = runConfigureLogin(sessionWithoutFormsAndFlowsWrites(), ['--apply'])

  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /lacks 9 scope\(s\) apply writes with/)
  assert.match(refused.stderr, /create:flows_vault_connections/)
  assert.match(refused.stderr, /auth0:login-policy-login/)
  assert.equal(refused.reachedAuth0, false)
})

test('login-policy preview is not gated on the scopes only apply writes with', () => {
  const previewed = runConfigureLogin(sessionWithoutFormsAndFlowsWrites(), [])

  // Preview writes nothing, so a scope it lacks costs a failed read rather
  // than a half-applied tenant. It must reach Auth0 rather than be refused.
  assert.doesNotMatch(previewed.stderr, /scope\(s\) apply writes with/)
  assert.equal(previewed.reachedAuth0, true)
})
