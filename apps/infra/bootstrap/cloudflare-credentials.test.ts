// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { decideCredentialRotation, writeCloudflareCredential } from './cloudflare-credentials.js'

function recordingWriters({ failParameter = false } = {}) {
  const parameter: string[] = []
  const environmentSecret: string[] = []
  // One list, so the order the two destinations are written in is observable — it decides which copy
  // is left stale when the second write fails.
  const order: string[] = []
  return {
    parameter,
    environmentSecret,
    order,
    writers: {
      writeParameter: (value: string) => {
        order.push('parameter')
        if (failParameter) throw new Error('ssm put-parameter exited 254')
        parameter.push(value)
      },
      writeEnvironmentSecret: (value: string) => {
        order.push('environmentSecret')
        environmentSecret.push(value)
      },
    },
  }
}

test('rotating a credential updates the copy CI reads, not just the SSM fallback', () => {
  // The regression this exists for: `--force` used to write SSM alone. The deploy workflows pass these
  // as Environment secrets and deployment/sst.ts uses an already-set variable as-is, so that copy is
  // what CI actually reads — rotating only SSM leaves a revoked token deploying.
  const { parameter, environmentSecret, writers } = recordingWriters()

  writeCloudflareCredential('rotated-token', writers)

  assert.deepEqual(parameter, ['rotated-token'])
  assert.deepEqual(environmentSecret, ['rotated-token'], 'the GitHub copy is the one CI reads')
})

test('both destinations receive the same value', () => {
  // A rotation that wrote different values would be worse than one that wrote none: CI and a local
  // deploy would then authenticate as different credentials with no sign anything was wrong.
  const { parameter, environmentSecret, writers } = recordingWriters()
  writeCloudflareCredential('one-value', writers)
  assert.deepEqual(parameter, environmentSecret)
})

test('a value surrounded by whitespace is stored trimmed, everywhere', () => {
  // Pasted tokens carry a trailing newline. Cloudflare rejects it, and the failure surfaces as a
  // provider auth error during a deploy rather than here.
  const { parameter, environmentSecret, writers } = recordingWriters()
  writeCloudflareCredential('  padded-token\n', writers)
  assert.deepEqual(parameter, ['padded-token'])
  assert.deepEqual(environmentSecret, ['padded-token'])
})

test('an empty credential is refused before either destination is touched', () => {
  // Half-written is the state with no recovery story: one store fresh, one stale, and nothing saying
  // which. Refusing up front keeps both at their previous values.
  for (const empty of ['', '   ', '\n']) {
    const { parameter, environmentSecret, writers } = recordingWriters()
    assert.throws(() => writeCloudflareCredential(empty, writers), /cannot be empty/)
    assert.deepEqual(parameter, [], 'nothing may be written to SSM')
    assert.deepEqual(environmentSecret, [], 'nothing may be written to GitHub')
  }
})

test('a rerun repairs a credential whose GitHub write failed after SSM succeeded', () => {
  // The regression: keying the skip on SSM alone made a torn pair permanent. CI kept the old token and
  // no rerun would fix it, because the check could not see the half that was missing.
  assert.equal(decideCredentialRotation({ parameterExists: true, environmentSecretExists: false, force: false }), 'write')
})

test('a rerun repairs the other half too', () => {
  assert.equal(decideCredentialRotation({ parameterExists: false, environmentSecretExists: true, force: false }), 'write')
})

test('a credential present in both places is left alone unless forced', () => {
  // Why a skip exists at all: never clobber a token that may have been rotated by hand since the last
  // run, and do not make the operator retype it on every bootstrap.
  assert.equal(decideCredentialRotation({ parameterExists: true, environmentSecretExists: true, force: false }), 'skip')
  assert.equal(decideCredentialRotation({ parameterExists: true, environmentSecretExists: true, force: true }), 'write')
})

test('a credential missing everywhere is written', () => {
  assert.equal(decideCredentialRotation({ parameterExists: false, environmentSecretExists: false, force: false }), 'write')
})

test('the copy CI reads is written first', () => {
  // Ordering is the whole mitigation for a half-completed rotation. If SSM went first, a failed GitHub
  // write would leave CI on the old token — deploying unattended, discovered only via a provider auth
  // error. This way the surviving half-write is the one whose failure the operator sees at the prompt.
  const { order, writers } = recordingWriters()
  writeCloudflareCredential('a-token', writers)
  assert.deepEqual(order, ['environmentSecret', 'parameter'])
})

test('a rotation that half-completes says so, and names the repair', () => {
  // The gap decideCredentialRotation cannot see: both destinations already existed, so both still
  // exist, and an ordinary rerun skips. Nothing else in the run knows the two now disagree, so this
  // error is the only warning the operator gets.
  const { parameter, environmentSecret, writers } = recordingWriters({ failParameter: true })

  assert.throws(() => writeCloudflareCredential('new-token', writers), /GitHub but not in SSM.*--force/s)

  assert.deepEqual(environmentSecret, ['new-token'], 'the CI copy took the new value')
  assert.deepEqual(parameter, [], 'SSM kept the old one, which is the divergence being reported')
})

test('the underlying failure is preserved, not swallowed', () => {
  // Wrapping must not hide which write failed or why — that is what tells the operator whether to
  // re-authenticate, fix a policy, or just rerun.
  const { writers } = recordingWriters({ failParameter: true })
  assert.throws(() => writeCloudflareCredential('new-token', writers), /ssm put-parameter exited 254/)
})
