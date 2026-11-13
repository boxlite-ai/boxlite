import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { onlyArtifact } from '../src/config.ts'
import { AuditFailedError, publish, type Run } from '../src/publish.ts'
import { config, credentials, ghcr, manifest, ok, response, tag } from './ghcr-fixture.ts'

const runnerTemp = mkdtempSync(join(tmpdir(), 'mbuild-publish-'))
after(() => rmSync(runnerTemp, { recursive: true, force: true }))
Object.assign(process.env, credentials, {
  GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'boxlite-ai/boxlite',
  GITHUB_WORKFLOW_REF: 'boxlite-ai/boxlite/.github/workflows/mbuild-release.yml@refs/heads/main',
  GITHUB_JOB: 'publish', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', RUNNER_TEMP: runnerTemp,
})

const probe = ({ auditFails = false } = {}) => {
  const published = new Set<string>()
  const calls: { command: string; args: string[] }[] = []
  const run: Run = async (command, args) => {
    calls.push({ command, args })
    if (command === 'curl') {
      if (args.at(-1)!.includes('/token?')) return response({ token: 'bearer-token' })
      const artifact = args.at(-1)!.split('/manifests/')[0]!.split('/').at(-1)!
      return published.has(artifact) ? response(manifest, 200, 'application/vnd.docker.distribution.manifest.v2+json') : response({ errors: [{ code: 'MANIFEST_UNKNOWN' }] }, 404)
    }
    if (command === 'npm') return auditFails ? { code: 1, stdout: '', stderr: 'audit unavailable' } : ok()
    assert.equal(command, 'docker')
    if (args[0] === 'push') published.add(args.at(-1)!.split('/').at(-1)!.split(':')[0]!)
    return ok()
  }
  return { run, calls }
}

test('controlled GHCR publication audits, builds missing artifacts and reuses existing images', async () => {
  const p = probe()
  const options = { config, stage: 'ghcr', registry: ghcr, tag, run: p.run, log: () => {} }
  assert.equal((await publish(options)).every(({ built }) => built), true)
  assert.equal((await publish(options)).some(({ built }) => built), false)
  assert.equal(p.calls.filter(({ command }) => command === 'npm').length, 1)
  const builds = p.calls.filter(({ args }) => args[0] === 'build')
  assert.equal(builds.length, 2)
  assert.ok(builds.every(({ args }) => args.includes('linux/amd64') && args.includes('org.opencontainers.image.source=https://github.com/boxlite-ai/boxlite')))
  assert.ok(p.calls.filter(({ args }) => args[0] === 'push').every(({ args }) => args.includes('linux/amd64')))
})

test('partial publication resumes only missing images and audit failure prevents builds', async () => {
  const p = probe()
  const options = { stage: 'ghcr', registry: ghcr, tag, run: p.run, log: () => {} }
  await publish({ ...options, config: onlyArtifact(config, 'api') })
  const outcomes = await publish({ ...options, config })
  assert.deepEqual(outcomes.map(({ artifact, built }) => ({ artifact, built })), [{ artifact: 'api', built: false }, { artifact: 'proxy', built: true }])
  const refused = probe({ auditFails: true })
  await assert.rejects(publish({ ...options, config, run: refused.run }), AuditFailedError)
  assert.equal(refused.calls.some(({ args }) => args[0] === 'build' || args[0] === 'push'), false)
})

test('unapproved publication contexts fail before registry access', async () => {
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'false', GITHUB_REPOSITORY: 'other/repository',
    GITHUB_WORKFLOW_REF: 'boxlite-ai/boxlite/.github/workflows/mbuild-release.yml@refs/heads/other',
    GITHUB_JOB: 'other', GITHUB_RUN_ID: 'invalid', GITHUB_RUN_ATTEMPT: '0', RUNNER_TEMP: 'relative' })) {
    const saved = process.env[key]!
    process.env[key] = value
    const p = probe()
    try {
      await assert.rejects(publish({ config, stage: 'ghcr', registry: ghcr, tag, run: p.run }), /mbuild-release/)
      assert.equal(p.calls.length, 0)
    } finally { process.env[key] = saved }
  }
})

test('separate publisher processes cannot share a publication interval and failures release locks', { timeout: 15_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mbuild-concurrent-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const worker = join(directory, 'worker.mjs')
  writeFileSync(worker, `import { publish } from ${JSON.stringify(new URL('../src/publish.ts', import.meta.url).href)};
const run = async () => { process.send({kind:'effect'}); await new Promise(resolve => process.once('message',resolve)); return {code:1,stdout:'',stderr:'controlled worker failure'}; };
try { await publish({config:${JSON.stringify(config)},stage:'ghcr',registry:${JSON.stringify(ghcr)},tag:${JSON.stringify(tag)},run,log:()=>{}}); }
catch(error) { process.send({kind:'failure',message:error.message}); process.exitCode=1; }
process.disconnect();`)
  const start = () => {
    const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url)), '--conditions=development', worker], { env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    t.after(() => { child.kill() })
    return { child, message: once(child, 'message').then(([value]) => value as { kind: string; message?: string }) }
  }
  const first = start()
  assert.equal((await first.message).kind, 'effect')
  const refused = await start().message
  assert.equal(refused.kind, 'failure', 'the competing publisher entered the registry boundary')
  assert.match(refused.message!, /already|locked/)
  const ended = once(first.child, 'exit'); first.child.send('release'); await ended
  const retry = start()
  assert.equal((await retry.message).kind, 'effect', 'a failed publisher retained its lock')
  const retried = once(retry.child, 'exit'); retry.child.send('release'); await retried
})
