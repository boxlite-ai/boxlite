import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { addressFor, ghcrRegistryFor, resolveRegistry } from '../src/address.ts'
import { onlyArtifact, parseBuildConfig } from '../src/config.ts'
import { ghcrRegistrar } from '../src/ghcr.ts'
import { AuditFailedError, NotPublishedError, promote, publish, ScanRefusedError, verifyPublished, type Run, type RunOptions } from '../src/publish.ts'

const sha = 'a'.repeat(40)
const tag = `v1.2.3-${sha}`
const ghcr = ghcrRegistryFor('BoxLite-AI/BoxLite')
const manifest = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.docker.distribution.manifest.v2+json', config: { digest: `sha256:${'b'.repeat(64)}` }, layers: [] })
const digest = `sha256:${createHash('sha256').update(manifest).digest('hex')}`
const config = parseBuildConfig({
  basePath: '/repo/apps/infra/mstage.env.json',
  base: JSON.stringify({ root: '../..', artifacts: { api: { dockerfile: 'apps/api/Dockerfile', context: '.' }, proxy: { dockerfile: 'apps/proxy/Dockerfile', context: '.' } } }),
  stagePath: '/repo/apps/infra/.mstage.config.json',
  stages: JSON.stringify({ stages: {
    dev: { home: 'gcp', project: 'project', region: 'us-east1', registry: { kind: 'artifact-registry', repository: 'images', immutableTags: true, scanOnPush: true }, scan: { blockOn: ['HIGH'], timeoutSeconds: 1 } },
    prod: { home: 'aws', region: 'us-east-1', registry: { kind: 'ecr', repository: 'images-prod', immutableTags: true, scanOnPush: true }, scan: { blockOn: ['HIGH'], timeoutSeconds: 1 } },
  } }),
})
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
const response = (body: unknown, status = 200) => ok(`${typeof body === 'string' ? body : JSON.stringify(body)}\n${status}`)

const probe = ({ missing = [] as string[], status = 200, tokenStatus = 200, existing = false, mismatch = '', scanHigh = false, auditFails = false, body = manifest, rewritePush = false } = {}) => {
  const calls: { command: string; args: string[]; options?: RunOptions }[] = []
  const targets = new Map<string, string>()
  const published = new Set(existing ? ['api', 'proxy'] : [])
  const run: Run = async (command, args, options) => {
    calls.push({ command, args, options })
    if (command === 'curl') {
      const url = args.at(-1)!
      if (url.includes('/token?')) return response({ token: 'bearer-token' }, tokenStatus)
      const artifact = url.split('/manifests/')[0]!.split('/').at(-1)!
      if (missing.includes(artifact)) return response({ errors: [{ code: 'MANIFEST_UNKNOWN' }] }, 404)
      if (status !== 200) return response({ errors: [{ code: 'DENIED' }] }, status)
      return published.has(artifact) ? response(body) : response({ errors: [{ code: 'MANIFEST_UNKNOWN' }] }, 404)
    }
    if (command === 'npm') return auditFails ? { code: 1, stdout: '', stderr: 'audit unavailable' } : ok()
    if (command === 'docker') {
      if (args[0] === 'push') {
        const address = args.at(-1)!
        if (address.startsWith('ghcr.io/')) published.add(address.split('/').at(-1)!.split(':')[0]!)
        else targets.set(address, rewritePush ? `sha256:${'f'.repeat(64)}` : digest)
      }
      return ok()
    }
    if (command === 'gcloud') {
      if (args.includes('repositories')) return ok('True')
      if (args.includes('configure-docker')) return ok()
      if (args.includes('--show-package-vulnerability')) return ok(JSON.stringify({ package_vulnerability_summary: { vulnerabilities: scanHigh ? { HIGH: [{}] } : {} } }))
      const address = `${args[4]}:${tag}`
      return ok(mismatch || targets.get(address) || '')
    }
    if (command === 'aws') {
      if (args[1] === 'describe-repositories') return ok()
      if (args[1] === 'get-login-password') return ok('ecr-token')
      if (args[1] === 'describe-image-scan-findings') return ok(JSON.stringify({ status: 'COMPLETE', counts: scanHigh ? { HIGH: 1 } : {} }))
      const imageTag = args[args.indexOf('--image-ids') + 1]!.slice('imageTag='.length)
      const address = `123456789012.dkr.ecr.us-east-1.amazonaws.com/images-prod:${imageTag}`
      const found = mismatch || targets.get(address)
      return found ? ok(found) : { code: 1, stdout: '', stderr: 'ImageNotFoundException' }
    }
    throw new Error(`Unexpected command ${command}`)
  }
  return { run, calls, targets }
}

const credentials = { GHCR_USERNAME: 'actor', GHCR_TOKEN: 'test-secret' }

test('GHCR addresses preserve the AR artifact/tag layout and reject invalid coordinates', () => {
  assert.equal(addressFor({ config, registry: ghcr, artifact: 'api', tag }), `ghcr.io/boxlite-ai/boxlite/api:${tag}`)
  for (const repository of ['../repo', 'owner/repo/extra', 'owner/repo\n', 'https://ghcr.io/repo']) assert.throws(() => ghcrRegistryFor(repository))
  assert.throws(() => addressFor({ config, registry: ghcr, artifact: 'api', tag: sha }), /release tag/)
})

test('GHCR reads hash the raw manifest and keep credentials out of argv', async () => {
  const p = probe({ existing: true })
  const registrar = ghcrRegistrar({ config, registry: ghcr, run: p.run, environment: credentials })
  assert.equal(await registrar.digestOf('api', tag), digest)
  await registrar.login()
  assert.equal(JSON.stringify(p.calls.map((call) => call.args)).includes('test-secret'), false)
  assert.match(p.calls[0]!.options!.stdin!, /Authorization: Basic/)
  assert.match(p.calls[1]!.options!.stdin!, /application\/vnd\.oci\.image\.index\.v1\+json/)
  assert.equal(p.calls.at(-1)!.options!.stdin, 'test-secret')
  assert.ok(p.calls[0]!.args.includes('--max-time'))
})

for (const status of [401, 403, 404, 429, 500]) test(`GHCR HTTP ${status} is not a missing manifest`, async () => {
  const p = probe({ existing: true, status })
  await assert.rejects(ghcrRegistrar({ config, registry: ghcr, run: p.run, environment: credentials }).digestOf('api', tag), new RegExp(`HTTP ${status}`))
})

test('GHCR distinguishes absence from token failures, malformed responses, indexes and transport failure', async () => {
  const absent = probe()
  assert.equal(await ghcrRegistrar({ config, registry: ghcr, run: absent.run, environment: credentials }).digestOf('api', tag), null)
  for (const p of [probe({ tokenStatus: 403 }), probe({ existing: true, body: '{' }), probe({ existing: true, body: JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json' }) })]) {
    await assert.rejects(ghcrRegistrar({ config, registry: ghcr, run: p.run, environment: credentials }).digestOf('api', tag))
  }
  const run: Run = async () => ({ code: 28, stdout: '', stderr: 'timeout' })
  await assert.rejects(ghcrRegistrar({ config, registry: ghcr, run, environment: credentials }).digestOf('api', tag), /curl exited 28/)
})

// Publication/import use the same adapter through their production facade.
process.env.GHCR_USERNAME = credentials.GHCR_USERNAME
process.env.GHCR_TOKEN = credentials.GHCR_TOKEN

test('GHCR publication audits once, builds missing images and reuses a completed release', async () => {
  const p = probe()
  const args = { config, stage: 'ghcr', registry: ghcr, tag, run: p.run, log: () => {} }
  assert.equal((await publish(args)).every((outcome) => outcome.built), true)
  assert.equal((await publish(args)).some((outcome) => outcome.built), false)
  assert.equal(p.calls.filter((call) => call.command === 'npm').length, 1)
  const builds = p.calls.filter((call) => call.args[0] === 'build')
  assert.equal(builds.length, 2)
  assert.ok(builds[0]!.args.includes('linux/amd64'))
  assert.ok(builds[0]!.args.includes('org.opencontainers.image.source=https://github.com/boxlite-ai/boxlite'))
  assert.ok(p.calls.filter((call) => call.args[0] === 'push').every((call) => call.args.includes('linux/amd64')))
  assert.equal((await verifyPublished(args)).length, 2)
})

test('GHCR publication stops before building on dependency audit failure', async () => {
  const p = probe({ auditFails: true })
  await assert.rejects(publish({ config, stage: 'ghcr', registry: ghcr, tag, run: p.run }), AuditFailedError)
  assert.equal(p.calls.some((call) => call.args[0] === 'build' || call.args[0] === 'push'), false)
})

test('a partial release retry builds only the artifact not already published', async () => {
  const p = probe()
  const args = { stage: 'ghcr', registry: ghcr, tag, run: p.run, log: () => {} }
  await publish({ ...args, config: onlyArtifact(config, 'api') })
  const outcomes = await publish({ ...args, config })
  assert.deepEqual(outcomes.map(({ artifact, built }) => ({ artifact, built })), [{ artifact: 'api', built: false }, { artifact: 'proxy', built: true }])
  assert.equal(p.calls.filter((call) => call.args[0] === 'push').length, 2)
})

for (const stage of ['dev', 'prod']) test(`GHCR import into ${stage} pins digests, reuses matches and enforces scanning`, async () => {
  const registry = resolveRegistry({ config, stage, region: stage === 'dev' ? 'us-east1' : 'us-east-1', project: 'project', accountId: '123456789012' })
  const p = probe({ existing: true })
  const args = { config, tag, from: { stage: 'ghcr', registry: ghcr }, to: { stage, registry }, run: p.run, log: () => {} }
  assert.equal((await promote(args)).every((outcome) => outcome.built), true)
  assert.ok(p.calls.filter((call) => call.args[0] === 'pull').every((call) => call.args.at(-1)?.endsWith(`@${digest}`)))
  assert.equal((await promote(args)).some((outcome) => outcome.built), false)
  assert.equal(p.calls.filter((call) => call.args[0] === 'push').length, 2)
  const refused = probe({ existing: true, scanHigh: true })
  await assert.rejects(promote({ ...args, run: refused.run }), ScanRefusedError)
  const mismatch = probe({ existing: true, mismatch: `sha256:${'f'.repeat(64)}` })
  await assert.rejects(promote({ ...args, run: mismatch.run }), /refusing to overwrite/)
  assert.equal(mismatch.calls.some((call) => call.args[0] === 'push'), false)
  const rewritten = probe({ existing: true, rewritePush: true })
  await assert.rejects(promote({ ...args, run: rewritten.run }), /Imported .* differs from GHCR/)
  assert.equal(rewritten.calls.filter((call) => call.args[0] === 'push').length, 1)
})

test('one missing GHCR artifact stops import before any destination operation', async () => {
  const p = probe({ existing: true, missing: ['proxy'] })
  const registry = resolveRegistry({ config, stage: 'dev', region: 'us-east1', project: 'project' })
  await assert.rejects(promote({ config, tag, from: { stage: 'ghcr', registry: ghcr }, to: { stage: 'dev', registry }, run: p.run }), NotPublishedError)
  assert.equal(p.calls.some((call) => call.command !== 'curl'), false)
})
