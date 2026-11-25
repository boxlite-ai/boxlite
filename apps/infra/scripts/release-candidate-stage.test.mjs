import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { verifyCandidate } from './release-candidate.mjs'

const command = fileURLToPath(new URL('./release-candidate.mjs', import.meta.url))
const config = new URL('../../../.github/ci-config.json', import.meta.url)
const hash = (data) => 'sha256:' + createHash('sha256').update(data).digest('hex')

test('stage binds candidate files and GHCR pins to the tagged commit and producer run', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'candidate-stage-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, '.github'))
  cpSync(config, join(dir, '.github/ci-config.json'))
  const index = []
  const version = '1.2.3',
    tag = 'v' + version,
    sha = 'a'.repeat(40)
  function group(name, files) {
    const path = join(dir, 'staged', name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'producer.json'), JSON.stringify({ run: 10, attempt: 1, sha }))
    for (const [key, bytes] of Object.entries(files)) writeFileSync(join(path, key), bytes)
    index.push({ id: index.length + 1, name, expired: false })
    return path
  }
  const runtime = { 'install.sh': 'installer', 'install.sh.sha256': hash('installer'), SHA256SUMS: 'checksums' }
  const packages = { ['boxlite-ai-boxlite-' + version + '.tgz']: 'main package' }
  for (const { os, target, rust_target } of JSON.parse(readFileSync(config)).platforms) {
    for (const base of ['boxlite-runtime-' + tag + '-' + target, 'boxlite-cli-' + tag + '-' + rust_target]) {
      runtime[base + '.tar.gz'] = base
      runtime[base + '.tar.gz.sha256'] = hash(base)
    }
    packages['boxlite-ai-boxlite-' + target + '-' + version + '.tgz'] = target
    group('c-sdk-' + target, { ['boxlite-c-' + tag + '-' + target + '.tar.gz']: target })
    group('wheels-' + os, { ['boxlite-' + version + '-cp312-' + target + '.whl']: os })
  }
  group('node-packages', packages)
  const runtimeDir = group('runtime-distribution', runtime)
  const archive = 'boxlite-runner-' + tag + '-linux-amd64.tar.gz'
  group('runner-linux-amd64', { [archive]: 'runner', [archive + '.sha256']: hash('runner') })
  const pins = { manifest: hash('manifest'), archive: hash('runner') }
  group('ghcr-runner', { 'runner.json': JSON.stringify(pins) })
  group('ghcr-api', { 'image.json': JSON.stringify([{ artifact: 'api', digest: hash('api') }]) })
  writeFileSync(join(dir, 'index.json'), JSON.stringify([{ artifacts: index }]))
  writeFileSync(
    join(dir, 'gh'),
    `#!/bin/sh
case "$*" in
  *commits/refs%2Ftags%2F*) printf '{"sha":"%s"}\\n' "$SHA" ;;
  *actions/runs/10/artifacts*) cat index.json ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  )
  const stage = (output) =>
    spawnSync(process.execPath, [command, 'stage'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: dir + ':' + process.env.PATH,
        GITHUB_REPOSITORY: 'boxlite-ai/boxlite',
        GITHUB_RUN_ATTEMPT: '2',
        GITHUB_RUN_ID: '10',
        TAG: tag,
        SHA: sha,
        IMAGES: '["api"]',
        RELEASE_ASSET_DIR: output,
      },
    })
  const result = stage('candidate')
  assert.equal(result.status, 0, result.stderr)
  const fingerprint = result.stdout.trim()
  const receipt = await verifyCandidate(join(dir, 'candidate'), { tag, sha, fingerprint })
  assert.deepEqual(receipt.runner, pins)
  assert.deepEqual(receipt.images, { api: hash('api') })
  assert.equal(receipt.producers['ghcr-api'].attempt, 1)
  assert.equal(receipt.assets['install.sh.sha256'].group, 'runtime-distribution')
  writeFileSync(join(dir, 'candidate', archive), 'different')
  await assert.rejects(verifyCandidate(join(dir, 'candidate'), { tag, sha, fingerprint }), /Changed release asset/)
  writeFileSync(join(runtimeDir, 'producer.json'), JSON.stringify({ run: 99, attempt: 1, sha }))
  assert.notEqual(stage('wrong-run').status, 0)
  writeFileSync(join(runtimeDir, 'producer.json'), JSON.stringify({ run: 10, attempt: 1, sha }))
  rmSync(join(runtimeDir, 'install.sh.sha256'))
  assert.match(stage('missing-sidecar').stderr, /Missing install.sh.sha256/)
})
