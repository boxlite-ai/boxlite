import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { kernelDeployment } from '../../runner/kernel.ts'
import { renderPolicyScripts, renderUpgradePayload } from '../stack/runner-upgrade.ts'

const fixture = (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), 'runner-kernel-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const payload = Buffer.from('downloaded kernel bytes')
  const digest = createHash('sha256').update(payload).digest('hex')
  const kernel = { url: 'https://example.test/kernel.bin', sha256: digest }
  writeFileSync(join(root, 'download'), payload)
  writeFileSync(
    join(bin, 'curl'),
    `#!/bin/bash
if [[ "$*" == *127.0.0.1* ]]; then echo '{"version":"0.10.7"}'; exit 0; fi
echo download >> "$TEST_ROOT/events"
[ ! -e "$TEST_ROOT/fail-download" ] || exit 22
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-o' ]; then cp "$TEST_ROOT/download" "$2"; exit; fi
  shift
done
exit 2
`,
  )
  writeFileSync(
    join(bin, 'systemctl'),
    `#!/bin/bash
echo "$*" >> "$TEST_ROOT/events"
if [ "$1" = restart ] && [ -f "$TEST_ROOT/fail-restart" ]; then
  rm "$TEST_ROOT/fail-restart"
  exit 1
fi
exit 0
`,
  )
  for (const name of ['curl', 'systemctl']) chmodSync(join(bin, name), 0o755)
  const localize = (script: string) =>
    script
      .replaceAll('/opt/boxlite', join(root, 'opt'))
      .replaceAll('/etc/boxlite', join(root, 'etc'))
      .replaceAll('/etc/systemd/system', join(root, 'units'))
      .replaceAll('/usr/local/bin', join(root, 'local-bin'))
  const run = (script: string) =>
    spawnSync('bash', ['-c', localize(script)], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_ROOT: root },
      encoding: 'utf8',
      timeout: 10_000,
    })
  return {
    root,
    kernel,
    payload,
    run,
    path: join(root, 'opt/kernels', digest, 'kernel.bin'),
    env: join(root, 'etc/kernel.env'),
    events: () => (existsSync(join(root, 'events')) ? readFileSync(join(root, 'events'), 'utf8') : ''),
  }
}

test('kernel deployment installs verified bytes and repeat convergence neither downloads nor restarts', (t) => {
  const f = fixture(t)
  const scripts = kernelDeployment(f.kernel)
  const first = f.run(scripts.enforce)
  assert.equal(first.status, 0, first.stderr)
  assert.deepEqual(readFileSync(f.path), f.payload)
  assert.equal(readFileSync(f.env, 'utf8'), `BOXLITE_KERNEL_PATH=${f.path}\n`)
  assert.equal((f.events().match(/^restart /gm) ?? []).length, 1)
  assert.equal(f.run(scripts.enforce).status, 0)
  assert.equal((f.events().match(/^restart /gm) ?? []).length, 1)
  assert.equal((f.events().match(/^download$/gm) ?? []).length, 1)
})

for (const failure of ['checksum', 'download']) {
  test(`kernel ${failure} failure leaves the live configuration and service untouched`, (t) => {
    const f = fixture(t)
    mkdirSync(dirname(f.env), { recursive: true })
    writeFileSync(f.env, 'BOXLITE_KERNEL_PATH=/previous/kernel.bin\n')
    if (failure === 'checksum') writeFileSync(join(f.root, 'download'), 'corrupt')
    else writeFileSync(join(f.root, 'fail-download'), '')
    const result = f.run(kernelDeployment(f.kernel).enforce)
    assert.equal(result.status, 1, result.stderr)
    assert.equal(readFileSync(f.env, 'utf8'), 'BOXLITE_KERNEL_PATH=/previous/kernel.bin\n')
    assert.doesNotMatch(f.events(), /restart|stop|daemon-reload/)
    assert.equal(existsSync(f.path), false)
  })
}

test('failed kernel activation restores the old configuration and restarts it', (t) => {
  const f = fixture(t)
  mkdirSync(dirname(f.env), { recursive: true })
  writeFileSync(f.env, 'BOXLITE_KERNEL_PATH=/previous/kernel.bin\n')
  writeFileSync(join(f.root, 'fail-restart'), '')
  const result = f.run(kernelDeployment(f.kernel).enforce)
  assert.equal(result.status, 1, result.stderr)
  assert.equal(readFileSync(f.env, 'utf8'), 'BOXLITE_KERNEL_PATH=/previous/kernel.bin\n')
  assert.equal((f.events().match(/^restart /gm) ?? []).length, 2)
  assert.equal(existsSync(join(f.root, 'units/boxlite-runner.service.d/kernel.conf')), false)
})

test('AWS update and GCP policy install a changed kernel even when the runner version matches', (t) => {
  const f = fixture(t)
  for (const name of ['local-bin/boxlite-runner', 'units/boxlite-runner.service']) {
    const path = join(f.root, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '')
    chmodSync(path, 0o755)
  }
  const target = {
    identity: '0.10.7',
    port: 3003,
    kernel: f.kernel,
    binary: {
      identity: '0.10.7',
      tarballName: 'runner.tar.gz',
      tarballUrl: 'https://example.test/runner.tar.gz',
      checksumUrl: 'https://example.test/runner.sha256',
      transport: 'https' as const,
      source: 'release' as const,
    },
  }
  const policy = renderPolicyScripts(target)
  assert.equal(f.run(policy.validate).status, 101, 'same binary must not hide a missing kernel')
  const result = f.run(renderUpgradePayload(target))
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readFileSync(f.path), f.payload)
  assert.equal(f.run(policy.validate).status, 100)
  rmSync(f.path)
  const enforced = f.run(policy.enforce)
  assert.equal(enforced.status, 100, enforced.stderr)
  assert.deepEqual(readFileSync(f.path), f.payload)
})

test('deployment rejects malformed digests and shell-bearing URLs before rendering', () => {
  for (const kernel of [
    { url: 'https://example.test/$(id)', sha256: 'a'.repeat(64) },
    { url: 'http://example.test/kernel', sha256: 'a'.repeat(64) },
    { url: 'https://example.test/kernel', sha256: 'a'.repeat(63) },
  ])
    assert.throws(() => kernelDeployment(kernel), /HTTPS asset URL/)
})
