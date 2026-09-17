/*
 * How a Cloud Run container is handed a secret by reference.
 *
 * `containerEnvironment` builds one list where ECS takes two arrays, so the
 * thing worth checking is that the two channels stay distinct inside it: a
 * value arrives with `value`, an address with `valueSource.secretKeyRef`, and
 * neither is ever rendered as the other.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  containerEnvironment,
  secretCoordinatesOf,
  splitSecretRef,
  versionedSecretRef,
} from '../stack/providers/gcp/secret-env.ts'

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

test('an unversioned stored address resolves latest', () => {
  assert.deepEqual(splitSecretRef('projects/boxlite-gcp-dev/secrets/boxlite-dev-oidc-client-secret'), {
    secret: 'boxlite-dev-oidc-client-secret',
    version: 'latest',
  })
})

test('every GCP shape mstage accepts is a shape this parses', () => {
  // One convention rather than two. Both land in the same Cloud Run field, so a
  // form mstage would write and this would reject is a deploy that fails on a
  // string neither side thinks is wrong. Read from mstage's own validator rather
  // than restated here — a copy is what lets the two drift.
  const source = readFileSync(fileURLToPath(new URL('../../mstage/src/environment/secret-address.ts', import.meta.url)), 'utf8')
  const declared = /gcp:\s*\{\s*pattern:\s*(\/.+?\/),/s.exec(source)
  assert.ok(declared, 'mstage no longer declares a gcp address pattern where this test looks for it')

  const pattern = new RegExp(declared[1]!.slice(1, -1))
  const address = 'projects/boxlite-gcp-dev/secrets/boxlite-dev-oidc-client-secret'
  for (const reference of [address, `${address}/versions/4`]) {
    assert.match(reference, pattern, 'the fixture below has to be an address mstage would accept')
    assert.doesNotThrow(() => splitSecretRef(reference))
  }
})

test('GKE gets a full payload resource while IAM gets its owning secret', () => {
  assert.equal(versionedSecretRef('projects/p/secrets/s'), 'projects/p/secrets/s/versions/latest')
  assert.equal(versionedSecretRef('projects/p/secrets/s/versions/7'), 'projects/p/secrets/s/versions/7')
  assert.deepEqual(secretCoordinatesOf('projects/other-project/secrets/s/versions/7'), {
    project: 'other-project',
    secret: 's',
  })
})

test('a string that is not a reference is refused, because it is a plaintext secret', () => {
  // Delivering it anyway would put the secret into the revision as if it named
  // one — the exact failure the reference channel exists to prevent.
  for (const wrong of ['arn:aws:secretsmanager:::secret:x', 'hunter2', 'projects/p/secrets', '']) {
    assert.throws(() => splitSecretRef(wrong), /is not a Secret Manager reference/)
  }
})

test('no provider spells a Secret Manager reference itself; they go through the one builder', () => {
  // The class rather than its instances. The shape written out at each call site
  // is how it goes wrong four times before anyone notices — which is exactly how
  // it went wrong upstream.
  //
  // What is forbidden is Cloud Run's `valueSource.secretKeyRef` and a hand-split
  // address. Kubernetes has a `secretKeyRef` of its own under `valueFrom`, and
  // it names a Kubernetes Secret rather than a Secret Manager address — a
  // different thing this module knows nothing about, pinned by the test below.
  //
  // Recursive: a provider moved into a subdirectory is still a provider, and a
  // guard that read only the top level would stop guarding the day one moves.
  const bundle = fileURLToPath(new URL('../stack/providers/gcp', import.meta.url))
  const offenders: string[] = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts') || entry.name === 'secret-env.ts') continue
      const source = readFileSync(full, 'utf8')
      // Code, not prose: a doc comment may name the field it is describing.
      const code = source
        .split('\n')
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join('\n')
      if (/valueSource:\s*\{?\s*secretKeyRef/.test(code) || /secrets\\\/\(\[\^\/\]\+\)/.test(code)) {
        offenders.push(entry.name)
      }
    }
  }
  walk(bundle)
  assert.deepEqual(offenders, [], 'these build a secret reference by hand instead of through secret-env.ts')
})

test('the one Kubernetes reference names a Kubernetes Secret, not a Secret Manager address', () => {
  /*
   * The proxy is the only workload on this cloud that is not Cloud Run, and its
   * key arrives through Kubernetes' own `valueFrom.secretKeyRef`. What that may
   * name is an object in the cluster — the one the CSI driver syncs from the
   * mount. A Secret Manager address there would be read as a Secret name, and
   * the container would start with an empty key rather than fail.
   */
  const edge = readFileSync(fileURLToPath(new URL('../stack/providers/gcp/edge.ts', import.meta.url)), 'utf8')
  const references = [...edge.matchAll(/valueFrom: \{ secretKeyRef: \{ name: ([A-Za-z_]+), key: ([A-Za-z_]+) \} \}/g)]
  assert.equal(references.length, 1, 'the proxy has one key, by one reference')
  assert.deepEqual(
    references[0].slice(1, 3),
    ['PROXY_API_KEY_SECRET', 'PROXY_API_KEY'],
    'the reference must name the synced Kubernetes Secret and the key inside it',
  )
  assert.match(edge, /const PROXY_API_KEY_SECRET = '[a-z-]+'/, 'and that name is a Kubernetes object name')
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
