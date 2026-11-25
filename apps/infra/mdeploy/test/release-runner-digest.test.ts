import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveRunnerBinary } from '../stack/runner-binary.ts'
import { renderRunnerBoot } from '../stack/runner-boot.ts'
import { renderUpgradePayload, upgradeTrigger } from '../stack/runner-upgrade.ts'

import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { runnerDigestFile } from '../stack/runner-registry.ts'

const sha = 'a'.repeat(40)
function target(manifest: string, archive: string) {
  const environment = {
    VERSION: '1.2.3',
    BOXLITE_RELEASE_DIGESTS: JSON.stringify({
      tag: 'v1.2.3',
      sha,
      runner: { manifest, archive },
    }),
  }
  const binary = resolveRunnerBinary({ configRoot: process.cwd(), environment })
  return { binary, identity: binary.identity, port: 3003 }
}
const digest = (digit: string) => 'sha256:' + digit.repeat(64)
test('draft host installs using the release candidate alone', () => {
  const candidate = target(digest('1'), digest('2'))
  const boot = renderRunnerBoot({
    ...candidate,
    apiUrl: 'https://api.example.com',
    otlpUrl: 'http://localhost:4318',
    environment: {},
    platform: {
      hostAddress: '',
      installVolumeMount: '',
      prepareKvm: '',
      prepareHome: '',
      startWrapper: null,
      unitEnvironment: {},
    },
  })
  const script = Buffer.from(boot, 'base64').toString()
  assert.ok(script.includes(digest('1')) && script.includes(digest('2')), 'host discarded the candidate pins')
  assert.ok(!script.includes('github.com/boxlite-ai/boxlite/releases/download/v1.2.3/'))
})
test('replacing a same-version runner changes both upgrade trigger and payload', () => {
  const old = target(digest('1'), digest('2'))
  const next = target(digest('3'), digest('4'))
  assert.notEqual(upgradeTrigger(old), upgradeTrigger(next))
  assert.notEqual(renderUpgradePayload(old), renderUpgradePayload(next))
})

test('fresh host verifies GHCR bytes without a Release attachment; a replaced digest reaches the swap', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'release-runner-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const archive = 'candidate archive'
  const hash = (data: string) => 'sha256:' + createHash('sha256').update(data).digest('hex')
  const layer = hash(archive)
  const manifest = JSON.stringify({
    artifactType: 'application/vnd.boxlite.runner.v1',
    annotations: { 'org.opencontainers.image.version': 'v1.2.3', 'org.opencontainers.image.revision': sha },
    layers: [{ digest: layer, mediaType: 'application/gzip' }],
  })
  const image = hash(manifest)
  const candidate = target(image, layer)
  const boot = Buffer.from(
    renderRunnerBoot({
      ...candidate,
      apiUrl: 'https://api.example.com',
      otlpUrl: 'http://localhost:4318',
      environment: {},
      platform: {
        hostAddress: '',
        installVolumeMount: '',
        prepareKvm: '',
        prepareHome: '',
        startWrapper: null,
        unitEnvironment: {},
      },
    }),
    'base64',
  ).toString()
  const start = boot.indexOf('RUNNER_MANIFEST=')
  const end = boot.indexOf('tar -xzf /tmp/boxlite-runner.tar.gz', start)
  assert.ok(start >= 0 && end > start)
  const download = boot.slice(start, end).replaceAll('/tmp/boxlite-runner.', dir + '/download.')
  writeFileSync(join(dir, 'manifest'), manifest)
  writeFileSync(join(dir, 'bytes'), archive)
  const mock = `curl() {
    case "$*" in
      *ghcr.io/token*) printf '%s' '{"token":"fixture"}' ;;
      *ghcr.io/v2/boxlite-ai/boxlite/runner/manifests/${image}*) cp "$FIXTURE/manifest" "\${@: -1}" ;;
      *ghcr.io/v2/boxlite-ai/boxlite/runner/blobs/${layer}*) cp "$FIXTURE/bytes" "\${@: -1}" ;;
      *127.0.0.1*) printf '%s' '{"version":"1.2.3"}' ;;
      *) return 22 ;;
    esac
  }
  systemctl() { return 0; }`
  const run = (fragment: string) =>
    spawnSync('bash', ['-c', 'set -euo pipefail\n' + mock + '\n' + fragment], {
      encoding: 'utf8',
      env: { ...process.env, FIXTURE: dir },
    })
  let result = run(download)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(join(dir, 'download.tar.gz'), 'utf8'), archive)
  writeFileSync(join(dir, 'bytes'), 'wrong archive')
  assert.notEqual(run(download).status, 0)
  writeFileSync(join(dir, 'manifest'), manifest + ' ')
  assert.notEqual(run(download).status, 0)

  const script = renderUpgradePayload(candidate)
  const guardEnd = script.indexOf('\nfi\n', script.indexOf('already serving $TARGET'))
  const guard = script
    .slice(script.indexOf('TARGET='), guardEnd + 4)
    .replaceAll(runnerDigestFile, join(dir, 'installed'))
    .replaceAll('/usr/local/bin/boxlite-runner', join(dir, 'binary'))
    .replaceAll('/etc/systemd/system/boxlite-runner.service', join(dir, 'unit'))
  writeFileSync(join(dir, 'binary'), 'fixture')
  chmodSync(join(dir, 'binary'), 0o755)
  writeFileSync(join(dir, 'unit'), 'fixture')
  writeFileSync(join(dir, 'installed'), image + ' ' + layer + '\n')
  result = run(guard + '\necho SWAP')
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /SWAP/)
  writeFileSync(join(dir, 'installed'), digest('3') + ' ' + digest('4') + '\n')
  result = run(guard + '\necho SWAP')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /SWAP/)
})
