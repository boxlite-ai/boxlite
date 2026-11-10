import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { addressFor, ghcrRegistryFor, resolveRegistry } from '../src/address.ts'
import { ghcrRegistrar } from '../src/ghcr.ts'
import { NotPublishedError, promote, verifyPublished, type Run, type RunOptions } from '../src/publish.ts'
import { config, credentials, digest, ghcr, manifest, ok, response, sha, tag } from './ghcr-fixture.ts'

const probe = ({ missing = false, status = 200, tokenStatus = 200, body = manifest, contentType = 'application/vnd.docker.distribution.manifest.v2+json', token = 'bearer-token' } = {}) => {
  const calls: { command: string; args: string[]; options?: RunOptions }[] = []
  const run: Run = async (command, args, options) => {
    calls.push({ command, args, options })
    if (command === 'docker' && args[0] === 'login') return ok()
    assert.equal(command, 'curl')
    if (args.at(-1)!.includes('/token?')) return response({ token }, tokenStatus)
    if (missing) return response({ errors: [{ code: 'MANIFEST_UNKNOWN' }] }, 404)
    return response(status === 200 ? body : { errors: [{ code: 'DENIED' }] }, status, contentType)
  }
  return { run, calls }
}

test('GHCR addresses retain AR artifact/tag names and reject invalid coordinates', () => {
  assert.equal(addressFor({ config, registry: ghcr, artifact: 'api', tag }), `ghcr.io/boxlite-ai/boxlite/api:${tag}`)
  for (const repository of ['../repo', 'owner/repo/extra', 'owner/repo\n', 'https://ghcr.io/repo']) assert.throws(() => ghcrRegistryFor(repository))
  assert.throws(() => addressFor({ config, registry: ghcr, artifact: 'api', tag: sha }), /release tag/)
})

test('GHCR hashes raw manifests and keeps credentials out of command arguments', async () => {
  const p = probe()
  const registrar = ghcrRegistrar({ config, registry: ghcr, run: p.run, environment: credentials })
  assert.equal(await registrar.digestOf('api', tag), digest)
  await registrar.login()
  assert.equal(JSON.stringify(p.calls.map(({ args }) => args)).includes('test-secret'), false)
  assert.match(p.calls[0]!.options!.stdin!, /Authorization: Basic/)
  assert.match(p.calls[1]!.options!.stdin!, /application\/vnd\.oci\.image\.index/)
  assert.equal(p.calls.at(-1)!.options!.stdin, 'test-secret')
  assert.ok(p.calls[0]!.args.includes('--max-time'))
})

for (const status of [401, 403, 404, 429, 500]) test(`HTTP ${status} is a read failure, not absence`, async () => {
  const p = probe({ status })
  await assert.rejects(ghcrRegistrar({ config, registry: ghcr, run: p.run, environment: credentials }).digestOf('api', tag), new RegExp(`HTTP ${status}`))
})

test('GHCR uses the response type when OCI omits the optional embedded mediaType', async () => {
  const body = JSON.stringify({ schemaVersion: 2, config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: `sha256:${'b'.repeat(64)}`, size: 2 }, layers: [] })
  const p = probe({ body, contentType: 'application/vnd.oci.image.manifest.v1+json; charset=utf-8' })
  assert.equal(await ghcrRegistrar({ config, registry: ghcr, run: p.run, environment: credentials }).digestOf('api', tag), `sha256:${createHash('sha256').update(body).digest('hex')}`)
  const conflict = probe({ contentType: 'application/vnd.oci.image.manifest.v1+json' })
  await assert.rejects(ghcrRegistrar({ config, registry: ghcr, run: conflict.run, environment: credentials }).digestOf('api', tag))
})

test('GHCR distinguishes missing images from authentication, malformed JSON, indexes and transport failures', async () => {
  const p = probe({ missing: true })
  assert.equal(await ghcrRegistrar({ config, registry: ghcr, run: p.run, environment: credentials }).digestOf('api', tag), null)
  for (const options of [{ tokenStatus: 403 }, { token: 'bad\ntoken' }, { body: '{' }, { body: '[]' },
    { body: JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json' }) }]) {
    const invalid = probe(options)
    await assert.rejects(ghcrRegistrar({ config, registry: ghcr, run: invalid.run, environment: credentials }).digestOf('api', tag))
  }
  const run: Run = async () => ({ code: 28, stdout: '', stderr: 'timeout' })
  await assert.rejects(ghcrRegistrar({ config, registry: ghcr, run, environment: credentials }).digestOf('api', tag), /curl exited 28/)
})

test('public GHCR verification is read-only and reports confirmed absence', async () => {
  Object.assign(process.env, credentials)
  const p = probe()
  assert.equal((await verifyPublished({ config, stage: 'ghcr', registry: ghcr, tag, run: p.run })).length, 2)
  assert.ok(p.calls.every(({ command }) => command === 'curl'))
  await assert.rejects(verifyPublished({ config, stage: 'ghcr', registry: ghcr, tag, run: probe({ missing: true }).run }), NotPublishedError)
})

test('a GHCR import destination is refused before any external command', async () => {
  let effects = 0
  const run: Run = async () => { effects++; return ok() }
  const cloud = resolveRegistry({ config, stage: 'dev', region: 'us-east1', project: 'project' })
  await assert.rejects(promote({ config, tag, from: { stage: 'dev', registry: cloud }, to: { stage: 'ghcr', registry: ghcr }, run }), /destination/)
  assert.equal(effects, 0)
})
