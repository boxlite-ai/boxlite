/*
 * How a Cloud Run container is handed a secret by reference.
 *
 * `containerEnvironment` builds one list where ECS takes two arrays, so the
 * thing worth checking is that the two channels stay distinct inside it: a
 * value arrives with `value`, an address with `valueSource.secretKeyRef`, and
 * neither is ever rendered as the other.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { containerEnvironment, splitSecretRef } from '../stack/providers/gcp/secret-env.ts'

const REFERENCE = 'projects/boxlite-gcp-dev/secrets/boxlite-dev-db-password/versions/4'

/** The globals the Pulumi engine installs, as much of them as this module reads. */
const installGlobals = () => {
  const target = globalThis as Record<string, unknown>
  target.$util = { output: (value: unknown) => ({ apply: (fn: any) => fn(value), __output: value }) }
  target.$resolve = (values: unknown[]) => ({ apply: (fn: any) => fn(values), __output: values })
}
installGlobals()

const read = (value: any): any => value.__output ?? value

test('a version reference is split into the two halves Cloud Run wants', () => {
  assert.deepEqual(splitSecretRef(REFERENCE), { secret: 'boxlite-dev-db-password', version: '4' })
  assert.deepEqual(splitSecretRef('projects/p/secrets/s/versions/latest'), { secret: 's', version: 'latest' })
})

test('a string that is not a reference is refused, because it is a plaintext secret', () => {
  // Delivering it anyway would put the secret into the revision as if it named
  // one — the exact failure the reference channel exists to prevent.
  for (const wrong of ['arn:aws:secretsmanager:::secret:x', 'hunter2', 'projects/p/secrets/s', '']) {
    assert.throws(() => splitSecretRef(wrong), /is not a Secret Manager version reference/)
  }
})

test('values and addresses arrive in one list and stay distinguishable inside it', () => {
  const entries = read(
    containerEnvironment({ values: { OIDC_AUDIENCE: 'boxlite' }, addresses: { DB_PASSWORD: REFERENCE } }),
  )
  assert.deepEqual(entries, [
    { name: 'OIDC_AUDIENCE', value: 'boxlite' },
    {
      name: 'DB_PASSWORD',
      valueSource: { secretKeyRef: { secret: 'boxlite-dev-db-password', version: '4' } },
    },
  ])
})

test('a container with no addresses is not asked to resolve anything', () => {
  const entries = read(containerEnvironment({ values: { PORT: '3000' }, addresses: {} }))
  assert.deepEqual(entries, [{ name: 'PORT', value: '3000' }])
  assert.ok(entries.every((entry: any) => entry.valueSource === undefined))
})

test('no address is ever rendered as a value', () => {
  // The whole point of the channel: the secret never enters the revision. What
  // enters it is the reference, and only in `valueSource`.
  const entries = read(containerEnvironment({ values: {}, addresses: { DB_PASSWORD: REFERENCE } }))
  assert.equal(entries[0].value, undefined)
  assert.equal(JSON.stringify(entries).includes('"value"'), false)
})
