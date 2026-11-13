import assert from 'node:assert/strict'
import test from 'node:test'
import { addressFor, resolveRegistry } from '../src/address.ts'
import { onlyArtifact } from '../src/config.ts'
import { NotPublishedError, promote, publish, ScanRefusedError, verifyPublished, type Run } from '../src/publish.ts'
import { config, credentials, digest, ghcr, manifest, ok, response, tag } from './ghcr-fixture.ts'

Object.assign(process.env, credentials)
const cloud = (stage: string) => resolveRegistry({ config, stage, region: stage === 'dev' ? 'us-east1' : 'us-east-1', project: 'project', accountId: '123456789012' })
const changedDigest = `sha256:${'f'.repeat(64)}`
const probe = ({ missing = [] as string[], tagSuffix = '', mismatch = false, existingTargets = false, rewritePush = false,
  rewriteCopy = false, copyFails = false, scanHigh = false, scanStates = ['FINISHED_SUCCESS'] } = {}) => {
  const targets = new Map<string, string>()
  if (existingTargets) for (const stage of ['dev', 'prod']) for (const artifact of Object.keys(config.artifacts)) {
    targets.set(addressFor({ config, registry: cloud(stage), artifact, tag }), digest)
  }
  const calls: { command: string; args: string[] }[] = []
  let scanReads = 0
  const run: Run = async (command, args) => {
    calls.push({ command, args })
    if (command === 'curl') {
      if (args.at(-1)!.includes('/token?')) return response({ token: 'bearer-token' })
      const artifact = args.at(-1)!.split('/manifests/')[0]!.split('/').at(-1)!
      return missing.includes(artifact) ? response({ errors: [{ code: 'MANIFEST_UNKNOWN' }] }, 404) : response(manifest, 200, 'application/vnd.docker.distribution.manifest.v2+json')
    }
    if (command === 'docker') {
      if (args[0] === 'buildx') {
        if (copyFails) return { code: 1, stdout: '', stderr: 'copy refused' }
        assert.equal(args.slice(0, 3).join(' '), 'buildx imagetools create')
        // Buildx defaults to wrapping a single manifest in an index unless disabled.
        targets.set(args[args.indexOf('--tag') + 1]!, rewriteCopy || !args.includes('--prefer-index=false') ? changedDigest : digest)
      } else if (args[0] === 'push') targets.set(args.at(-1)!, rewritePush ? changedDigest : digest)
      return ok()
    }
    if (command === 'gcloud') {
      if (args.includes('repositories')) return ok('True')
      if (args.includes('configure-docker')) return ok()
      if (args.includes('--show-package-vulnerability')) {
        const state = scanStates[Math.min(scanReads++, scanStates.length - 1)]
        // This occurrence shape was serialized from SDK 583's v1 message.
        return ok(JSON.stringify({ ...(state ? { discovery_summary: { discovery: [{ discovery: { analysisStatus: state }, kind: 'DISCOVERY' }] } } : {}),
          package_vulnerability_summary: { vulnerabilities: scanHigh && ['FINISHED_SUCCESS', 'COMPLETE'].includes(state!) ? { HIGH: [{}] } : {} } }))
      }
      const found = mismatch ? changedDigest : targets.get(`${args[4]}:${tag}`)
      if (args.some((arg) => arg.startsWith('--format=json'))) return ok(JSON.stringify([
        ...(tagSuffix ? [{ version: digest, tags: [`${tag}${tagSuffix}`] }] : []), ...(found ? [{ version: found, tags: [tag] }] : []),
      ]))
      return ok(found || (tagSuffix ? digest : ''))
    }
    if (command === 'aws') {
      if (args[1] === 'describe-repositories' || args[1] === 'get-login-password') return ok('token')
      if (args[1] === 'describe-image-scan-findings') return ok(JSON.stringify({ status: 'COMPLETE', counts: scanHigh ? { HIGH: 1 } : {} }))
      const imageTag = args[args.indexOf('--image-ids') + 1]!.slice('imageTag='.length)
      const found = mismatch ? changedDigest : targets.get(`123456789012.dkr.ecr.us-east-1.amazonaws.com/images-prod:${imageTag}`)
      return found ? ok(found) : { code: 1, stdout: '', stderr: 'ImageNotFoundException' }
    }
    throw new Error(`Unexpected command ${command}`)
  }
  return { run, calls, targets }
}
const importing = (p: ReturnType<typeof probe>, stage = 'dev') => ({ config, tag, from: { stage: 'ghcr', registry: ghcr }, to: { stage, registry: cloud(stage) }, run: p.run, log: () => {} })

for (const stage of ['dev', 'prod']) test(`GHCR import into ${stage} preserves digests, reuses matches and enforces scans`, async () => {
  const p = probe()
  assert.equal((await promote(importing(p, stage))).every(({ built }) => built), true)
  const copies = p.calls.filter(({ args }) => args[0] === 'buildx')
  assert.equal(copies.length, 2)
  assert.ok(copies.every(({ args }) => args.at(-1)?.endsWith(`@${digest}`)))
  assert.equal((await promote(importing(p, stage))).some(({ built }) => built), false)
  assert.equal(p.calls.filter(({ args }) => args[0] === 'buildx').length, 2)
  const refused = probe({ scanHigh: true })
  await assert.rejects(promote(importing(refused, stage)), ScanRefusedError)
  const mismatch = probe({ mismatch: true })
  await assert.rejects(promote(importing(mismatch, stage)), /refusing to overwrite/)
  assert.equal(mismatch.targets.size, 0)
  const changed = probe({ rewriteCopy: true })
  await assert.rejects(promote(importing(changed, stage)), /differs from GHCR/)
  assert.equal(changed.targets.size, 1)
  await assert.rejects(promote(importing(probe({ copyFails: true }), stage)), /Could not import/)
})

test('a missing source prevents all destination operations and copies avoid local-store rewriting', async () => {
  const missing = probe({ missing: ['proxy'] })
  await assert.rejects(promote(importing(missing)), NotPublishedError)
  assert.ok(missing.calls.every(({ command }) => command === 'curl'))
  const rewrittenStore = probe({ rewritePush: true })
  await assert.doesNotReject(promote(importing(rewrittenStore)))
  assert.equal(rewrittenStore.targets.size, 2)
  assert.ok([...rewrittenStore.targets.values()].every((value) => value === digest))
})

test('AR verification and import do not reuse a longer tag prefix', async () => {
  const p = probe({ tagSuffix: '-backup' })
  await assert.rejects(verifyPublished({ config, stage: 'dev', registry: cloud('dev'), tag, run: p.run }), NotPublishedError)
  assert.equal((await promote(importing(p))).every(({ built }) => built), true)
})

test('AR publication waits for discovery before weighing vulnerabilities', async () => {
  let elapsed = 0
  const clock = { now: () => elapsed, wait: async (ms: number) => { elapsed += ms } }
  const options = { config: onlyArtifact(config, 'api'), stage: 'dev', registry: cloud('dev'), tag, clock, log: () => {} }
  await assert.rejects(publish({ ...options, run: probe({ existingTargets: true, scanHigh: true, scanStates: ['SCANNING', 'FINISHED_SUCCESS'] }).run }), ScanRefusedError)
  assert.ok(elapsed > 0)
  elapsed = 0
  await assert.doesNotReject(publish({ ...options, run: probe({ existingTargets: true, scanStates: ['PENDING', 'COMPLETE'] }).run }))
  assert.ok(elapsed > 0)
})

for (const states of [[], ['FINISHED_FAILED'], ['FINISHED_UNSUPPORTED'], ['UNKNOWN']]) test(`AR scan refuses ${states.join() || 'absent discovery'}`, async () => {
  let elapsed = 0
  await assert.rejects(publish({ config: onlyArtifact(config, 'api'), stage: 'dev', registry: cloud('dev'), tag,
    run: probe({ existingTargets: true, scanStates: states }).run, log: () => {}, clock: { now: () => elapsed, wait: async (ms) => { elapsed += ms } } }), /scan/i)
})

test('malformed or ambiguous AR tag metadata is an operational failure', async () => {
  for (const body of ['{', '{}', '[null]', JSON.stringify([{ version: digest }]),
    JSON.stringify([{ version: digest, tags: [tag] }, { version: changedDigest, tags: [tag] }]), JSON.stringify([{ version: 'invalid', tags: [tag] }])]) {
    const p = probe({ existingTargets: true })
    const run: Run = (command, args, options) => command === 'gcloud' && args[3] === 'list' && args.some((arg) => arg.startsWith('--format=json')) ? Promise.resolve(ok(body)) : p.run(command, args, options)
    await assert.rejects(verifyPublished({ config, stage: 'dev', registry: cloud('dev'), tag, run }), /Invalid|Ambiguous/)
  }
})
