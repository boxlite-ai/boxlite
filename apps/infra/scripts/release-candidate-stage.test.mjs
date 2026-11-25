import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { linuxClients, verifyAcceptedDistribution, verifyCandidate } from './release-candidate.mjs'

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
    const wheel = target === 'linux-x64-gnu' ? linuxClients(tag)['wheels-ubuntu-latest'][0] : 'boxlite-' + version + '-cp312-' + target + '.whl'
    group('wheels-' + os, { [wheel]: os })
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
  *attempts/2/jobs*) cat jobs.json ;;
  *releases/7/assets*) jq -s '[.]' uploads.jsonl ;;
  *releases/7) printf '{"tag_name":"v1.2.3","draft":true}' ;;
  'release upload '*) name=$(basename "$4"); digest=$(shasum -a 256 "$4" | cut -d' ' -f1); jq -nc --arg name "$name" --arg digest "sha256:$digest" '{name:$name,digest:$digest,state:"uploaded"}' >>uploads.jsonl ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  )
  const stage = (output, mode = 'stage', extra = {}) =>
    spawnSync(process.execPath, [command, mode], {
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
        ...extra,
      },
    })
  const early = stage('deploy', 'deployment')
  assert.equal(early.status, 0, early.stderr)
  const deploy = await verifyCandidate(join(dir, 'deploy'), { tag, sha, fingerprint: early.stdout.trim() })
  assert.deepEqual(deploy.assets, {})
  assert.deepEqual(deploy.runner, pins)
  const result = stage('candidate')
  assert.equal(result.status, 0, result.stderr)
  const fingerprint = result.stdout.trim()
  const receipt = await verifyCandidate(join(dir, 'candidate'), { tag, sha, fingerprint })
  assert.deepEqual(receipt.runner, pins)
  assert.deepEqual(receipt.images, { api: hash('api') })
  assert.equal(receipt.producers['ghcr-api'].attempt, 1)
  assert.equal(receipt.assets['install.sh.sha256'].group, 'runtime-distribution')
  writeFileSync(join(dir, 'uploads.jsonl'), '')
  for (let attempt = 0; attempt < 2; attempt++) {
    const attached = stage('candidate', 'attach', { CANDIDATE_DIGEST: fingerprint, RELEASE_ID: '7', REPAIR_GROUP: 'runtime-distribution' })
    assert.equal(attached.status, 0, attached.stderr)
    const names = readFileSync(join(dir, 'uploads.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).name)
    assert.deepEqual(names.sort(), Object.keys(runtime).sort(), 'Each runtime file, including install.sh.sha256, uploads exactly once across retries')
  }
  const e2e = join(dir, 'linux-clients')
  const clients = {}
  for (const [group, files] of Object.entries(linuxClients(tag))) {
    const path = join(e2e, group)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'producer.json'), JSON.stringify({ run: 10, attempt: 1, sha }))
    for (const name of files) {
      const bytes = readFileSync(join(dir, 'candidate', name))
      writeFileSync(join(path, name), bytes)
      clients[name] = hash(bytes)
    }
  }
  const prepare = () => stage('deploy', 'clients', { CLIENT_ARTIFACT_DIR: e2e, CANDIDATE_DIGEST: early.stdout.trim() })
  const prepared = prepare()
  assert.equal(prepared.status, 0, prepared.stderr)
  const tested = JSON.parse(readFileSync(join(dir, 'deploy', 'tested-clients.json')))
  assert.deepEqual(tested, clients)
  const full = receipt
  const acceptance = { tag, sha, run: 10, clients: tested }
  verifyAcceptedDistribution(full, acceptance, deploy)
  const macWheel = 'boxlite-1.2.3-cp312-darwin-arm64.whl'
  const macGroup = receipt.assets[macWheel].group
  writeFileSync(join(dir, 'staged', macGroup, macWheel), 'rebuilt macOS wheel')
  writeFileSync(join(dir, 'staged', macGroup, 'producer.json'), JSON.stringify({ run: 10, attempt: 2, sha }))
  const rebuild = stage('rebuilt')
  assert.equal(rebuild.status, 0, rebuild.stderr)
  const changed = await verifyCandidate(join(dir, 'rebuilt'), { tag, sha, fingerprint: rebuild.stdout.trim() })
  assert.notEqual(changed.assets[macWheel].digest, full.assets[macWheel].digest)
  verifyAcceptedDistribution(changed, acceptance, deploy)
  writeFileSync(join(dir, 'rebuilt', macWheel), 'changed after verification')
  await assert.rejects(verifyCandidate(join(dir, 'rebuilt'), { tag, sha, fingerprint: rebuild.stdout.trim() }), /Changed release asset/)
  const single = stage('wheels', 'component', { COMPONENT_GROUP: 'wheels-' })
  assert.equal(single.status, 0, single.stderr)
  const wheels = await verifyCandidate(join(dir, 'wheels'), { tag, sha, fingerprint: single.stdout.trim() })
  assert.deepEqual(Object.keys(wheels.producers).sort(), index.map((entry) => entry.name).filter((name) => name.startsWith('wheels-')).sort())
  assert.ok(Object.values(wheels.assets).every(({ group }) => group.startsWith('wheels-')))
  assert.throws(() => verifyAcceptedDistribution(full, { ...acceptance, clients: {} }, deploy))
  const file = Object.keys(tested)[0]
  assert.throws(
    () => verifyAcceptedDistribution(full, { ...acceptance, clients: { ...tested, [file]: hash('rebuilt') } }, deploy),
    /differs from dev/,
  )
  assert.throws(() => verifyAcceptedDistribution(full, acceptance, { ...deploy, images: { api: hash('new image') } }))
  writeFileSync(join(e2e, 'npm-linux-x64-gnu', 'producer.json'), JSON.stringify({ run: 11, attempt: 1, sha }))
  assert.notEqual(prepare().status, 0)
  for (const name of Object.keys(linuxClients(tag))) {
    if (!index.some((item) => item.name === name)) index.push({ name, id: index.length + 1, expired: false })
  }
  writeFileSync(join(dir, 'index.json'), JSON.stringify([{ artifacts: index }]))
  writeFileSync(
    join(dir, 'jobs.json'),
    JSON.stringify([{ jobs: [{ name: 'build-runtime / Build Runtime (darwin-arm64)', status: 'in_progress' }] }]),
  )
  const ready = stage('unused', 'client-ids')
  assert.equal(ready.status, 0, ready.stderr)
  assert.deepEqual(
    ready.stdout.trim().split(',').map(Number),
    Object.keys(linuxClients(tag)).map((name) => index.find((item) => item.name === name).id),
  )
  writeFileSync(
    join(dir, 'jobs.json'),
    JSON.stringify([
      { jobs: [{ name: 'build-node / Build (linux-x64-gnu)', status: 'completed', conclusion: 'failure' }] },
    ]),
  )
  assert.match(stage('unused', 'client-ids').stderr, /Linux client build failed/)
  writeFileSync(join(dir, 'candidate', archive), 'different')
  await assert.rejects(verifyCandidate(join(dir, 'candidate'), { tag, sha, fingerprint }), /Changed release asset/)
  writeFileSync(join(runtimeDir, 'producer.json'), JSON.stringify({ run: 99, attempt: 1, sha }))
  assert.notEqual(stage('wrong-run').status, 0)
  writeFileSync(join(runtimeDir, 'producer.json'), JSON.stringify({ run: 10, attempt: 1, sha }))
  rmSync(join(runtimeDir, 'install.sh.sha256'))
  assert.match(stage('missing-sidecar').stderr, /Missing install.sh.sha256/)
})
