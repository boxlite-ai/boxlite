import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { kernelDeployment } from '../stack/runner-kernel.ts'
import {
  renderHostConvergence,
  renderPolicyScripts,
  renderUnitEnvironmentPolicyScripts,
  renderUpgradePayload,
} from '../stack/runner-upgrade.ts'

const fixture = (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), 'runner-kernel-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  mkdirSync(join(root, 'locks'))
  mkdirSync(join(root, 'tmp'))
  const payload = Buffer.from('downloaded kernel bytes')
  const digest = createHash('sha256').update(payload).digest('hex')
  const kernel = { url: 'https://example.test/kernel.bin', sha256: digest }
  writeFileSync(join(root, 'download'), payload)
  writeFileSync(
    join(bin, 'curl'),
    `#!/bin/bash
if [[ "$*" == *127.0.0.1* ]]; then
  echo "probe $*" >> "$TEST_ROOT/events"
  [ ! -e "$TEST_ROOT/fail-health" ] || exit 7
  if [ -e "$TEST_ROOT/health-failures" ]; then
    remaining=$(cat "$TEST_ROOT/health-failures")
    if [ "$remaining" -gt 0 ]; then
      echo "$((remaining - 1))" > "$TEST_ROOT/health-failures"
      exit 7
    fi
  fi
  if [ -e "$TEST_ROOT/health-body" ]; then cat "$TEST_ROOT/health-body"
  else printf '{"version":"%s","custom_kernel":"supported"}\\n' "$(cat "$TEST_ROOT/identity" 2>/dev/null || echo 0.10.7)"; fi
  if [[ "$*" == *--write-out* ]]; then cat "$TEST_ROOT/health-status" 2>/dev/null || echo 200; fi
  exit 0
fi
echo download >> "$TEST_ROOT/events"
if [ "\${PAUSE_DOWNLOAD:-}" = 1 ]; then
  echo kernel-download-paused
  read -r _
fi
[ ! -e "$TEST_ROOT/fail-download" ] || exit 22
while [ "$#" -gt 0 ]; do
  if [[ "$1" == https://* ]]; then asset="\${1##*/}"; fi
  if [ "$1" = '-o' ]; then
    source="$TEST_ROOT/download-$asset"
    [ -f "$source" ] || source="$TEST_ROOT/download"
    cp "$source" "$2"
    exit
  fi
  shift
done
exit 2
`,
  )
  writeFileSync(
    join(bin, 'systemctl'),
    `#!/bin/bash
echo "$*" >> "$TEST_ROOT/events"
if [ "$1" = is-enabled ] && [ -e "$TEST_ROOT/disabled" ]; then exit 1; fi
if [ "$1" = is-active ] && [ -e "$TEST_ROOT/inactive" ]; then exit 3; fi
if [ -e "$TEST_ROOT/rollback-started" ] && [ -e "$TEST_ROOT/fail-rollback-$1" ]; then exit 1; fi
if [ "$1" = restart ] && [ -f "$TEST_ROOT/fail-restart" ]; then
  rm "$TEST_ROOT/fail-restart"
  exit 1
fi
if [ "$1" = restart ]; then
  mkdir -p "$TEST_ROOT/proc/1234"
  tr '\\n' '\\0' < "$TEST_ROOT/etc/kernel.env" > "$TEST_ROOT/proc/1234/environ"
fi
if [ "$1" = show ]; then cat "$TEST_ROOT/main-pid" 2>/dev/null || echo 1234; fi
exit 0
`,
  )
  writeFileSync(
    join(bin, 'ss'),
    `#!/bin/bash
echo "ss $*" >> "$TEST_ROOT/events"
pid=$(cat "$TEST_ROOT/listener-pid" 2>/dev/null || echo 1234)
echo "LISTEN 0 4096 *:3003 *:* users:((boxlite-runner,pid=$pid,fd=7))"
`,
  )
  writeFileSync(join(bin, 'sleep'), '#!/bin/bash\necho "sleep $*" >> "$TEST_ROOT/events"\n')
  for (const name of ['curl', 'systemctl', 'ss', 'sleep']) chmodSync(join(bin, name), 0o755)
  const localize = (script: string) =>
    script
      .replaceAll('/opt/boxlite', join(root, 'opt'))
      .replaceAll('/etc/boxlite', join(root, 'etc'))
      .replaceAll('/etc/systemd/system', join(root, 'units'))
      .replaceAll('/usr/local/bin', join(root, 'local-bin'))
      .replaceAll('/run/lock', join(root, 'locks'))
      .replaceAll('/proc/', join(root, 'proc') + '/')
  const environment = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_ROOT: root, TMPDIR: join(root, 'tmp') }
  const run = (script: string) =>
    spawnSync('bash', ['-c', localize(script)], {
      env: environment,
      encoding: 'utf8',
      timeout: 10_000,
    })
  return {
    root,
    kernel,
    payload,
    run,
    localize,
    environment,
    path: join(root, 'opt/kernels', digest, 'kernel.bin'),
    env: join(root, 'etc/kernel.env'),
    dropin: join(root, 'units/boxlite-runner.service.d/kernel.conf'),
    events: () => (existsSync(join(root, 'events')) ? readFileSync(join(root, 'events'), 'utf8') : ''),
  }
}

test('boot kernel installation writes verified bytes, environment and systemd drop-in', (t) => {
  const f = fixture(t)
  const result = f.run(kernelDeployment(f.kernel).install)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readFileSync(f.path), f.payload)
  assert.equal(readFileSync(f.env, 'utf8'), `BOXLITE_KERNEL_PATH=${f.path}\n`)
  assert.equal(readFileSync(f.dropin, 'utf8'), `[Service]\nEnvironmentFile=${f.env}\n`)
  assert.doesNotMatch(f.events(), /restart|probe/)
})

test('kernel HTTPS downloads retry transient failures within the total deadline', { timeout: 30_000 }, async (t) => {
  const tls = mkdtempSync(join(tmpdir(), 'runner-kernel-tls-'))
  t.after(() => rmSync(tls, { recursive: true, force: true }))
  const key = join(tls, 'key.pem')
  const cert = join(tls, 'cert.pem')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  )
  let mode = ''
  let requests = 0
  let payload = Buffer.alloc(0)
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_request, response) => {
    requests += 1
    if (mode === 'deadline') {
      response.writeHead(200, { 'Content-Length': payload.length })
      response.write(payload.subarray(0, 1))
    } else if (mode === 'exhausted' || requests === 1) {
      response.writeHead(503).end()
    } else {
      response.writeHead(200).end(payload)
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  for (const scenario of ['recovered', 'exhausted', 'deadline']) {
    await t.test(scenario, async (t) => {
      const f = fixture(t)
      rmSync(join(f.root, 'bin', 'curl'))
      mode = scenario
      requests = 0
      payload = f.payload
      const kernel = { ...f.kernel, url: `https://127.0.0.1:${address.port}/kernel.bin` }
      let script = f.localize(kernelDeployment(kernel).install)
      if (scenario === 'deadline') {
        // Scale only time budgets: a partial transfer times out before the retry delay ends.
        script = script.replace('timeout 120 curl', 'timeout 1 curl').replace('--max-time 120', '--max-time 0.2')
      }
      const started = performance.now()
      const child = spawn('bash', ['-c', script], {
        env: { ...f.environment, CURL_CA_BUNDLE: cert, NO_PROXY: '127.0.0.1' },
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: 15_000,
      })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      const [code, signal] = await once(child, 'close')
      assert.equal(signal, null, stderr)
      if (scenario === 'recovered') {
        assert.equal(code, 0, stderr)
        assert.equal(requests, 2)
        assert.deepEqual(readFileSync(f.path), f.payload)
        assert.equal(readFileSync(f.env, 'utf8'), `BOXLITE_KERNEL_PATH=${f.path}\n`)
        assert.equal(readFileSync(f.dropin, 'utf8'), `[Service]\nEnvironmentFile=${f.env}\n`)
      } else {
        assert.equal(code, 1, stderr)
        assert.equal(requests, scenario === 'exhausted' ? 6 : 1)
        assert.equal(existsSync(f.path), false)
        assert.equal(existsSync(f.env), false)
        assert.equal(existsSync(f.dropin), false)
        assert.match(stderr, /runner kernel download or SHA256 verification failed/)
        if (scenario === 'deadline') assert.ok(performance.now() - started < 3_000, stderr)
      }
      assert.deepEqual(
        readdirSync(dirname(f.path)).filter((name) => name.startsWith('.download.')),
        [],
      )
      assert.doesNotMatch(f.events(), /restart|stop|daemon-reload/)
    })
  }
})

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
  assert.equal((f.events().match(/^probe /gm) ?? []).length, 2)
  assert.doesNotMatch(f.events(), /^sleep /m)
})

for (const drift of ['duplicate assignment', 'stale process', 'missing process environment']) {
  test(`kernel convergence repairs ${drift}`, (t) => {
    const f = fixture(t)
    const scripts = kernelDeployment(f.kernel)
    assert.equal(f.run(scripts.enforce).status, 0)
    const processEnv = join(f.root, 'proc/1234/environ')
    if (drift === 'duplicate assignment') {
      writeFileSync(f.env, `BOXLITE_KERNEL_PATH=${f.path}\nBOXLITE_KERNEL_PATH=/previous/kernel.bin\n`)
    } else if (drift === 'stale process') {
      writeFileSync(processEnv, 'BOXLITE_KERNEL_PATH=/previous/kernel.bin\0')
    } else {
      rmSync(processEnv)
    }

    const result = f.run(scripts.enforce)

    assert.equal(result.status, 0, result.stderr)
    assert.equal((f.events().match(/^restart /gm) ?? []).length, 2)
    assert.equal(readFileSync(f.env, 'utf8'), `BOXLITE_KERNEL_PATH=${f.path}\n`)
    assert.equal(readFileSync(processEnv, 'utf8'), `BOXLITE_KERNEL_PATH=${f.path}\0`)
    assert.equal((f.events().match(/^download$/gm) ?? []).length, 1)
  })
}

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

for (const filename of ['kernel.env', 'kernel.conf']) {
  test(`failed ${filename} backup removes incomplete temporary state without changing the runner`, (t) => {
    const f = fixture(t)
    const previousEnv = 'BOXLITE_KERNEL_PATH=/previous/kernel.bin\n'
    const previousDropin = '[Service]\nEnvironmentFile=/previous/kernel.env\n'
    mkdirSync(dirname(f.env), { recursive: true })
    mkdirSync(dirname(f.dropin), { recursive: true })
    writeFileSync(f.env, previousEnv)
    writeFileSync(f.dropin, previousDropin)
    const cp = execFileSync('sh', ['-c', 'command -v cp'], { encoding: 'utf8' }).trim()
    writeFileSync(
      join(f.root, 'bin/cp'),
      `#!/bin/bash
destination=\${@: -1}
if [[ "$destination" == "$TEST_ROOT/tmp/"*/${filename} ]]; then
  echo backup-failed >> "$TEST_ROOT/events"
  exit 1
fi
exec '${cp}' "$@"
`,
      { mode: 0o755 },
    )

    const result = f.run(kernelDeployment(f.kernel).enforce)

    assert.equal(result.status, 1, result.stderr)
    assert.match(f.events(), /^backup-failed$/m)
    assert.deepEqual(readdirSync(join(f.root, 'tmp')), [])
    assert.equal(readFileSync(f.env, 'utf8'), previousEnv)
    assert.equal(readFileSync(f.dropin, 'utf8'), previousDropin)
    assert.doesNotMatch(f.events(), /restart|stop|daemon-reload/)
    assert.match(result.stderr, /runner kernel backup failed/)
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

for (const failure of [
  'restart',
  'health',
  'status',
  'version',
  'capability-missing',
  'capability-false',
  'main-pid',
  'listener-pid',
]) {
  test(`kernel ${failure} activation failure restores the existing environment and drop-in exactly`, (t) => {
    const f = fixture(t)
    const previousEnv = 'BOXLITE_KERNEL_PATH=/previous/kernel.bin\n'
    const previousDropin = '[Service]\n# previous kernel configuration\nEnvironmentFile=/previous/kernel.env\n'
    mkdirSync(dirname(f.env), { recursive: true })
    mkdirSync(dirname(f.dropin), { recursive: true })
    writeFileSync(f.env, previousEnv, { mode: 0o640 })
    writeFileSync(f.dropin, previousDropin, { mode: 0o600 })
    if (failure === 'restart' || failure === 'health') writeFileSync(join(f.root, `fail-${failure}`), '')
    if (failure === 'status') writeFileSync(join(f.root, 'health-status'), '201\n')
    if (failure === 'version') writeFileSync(join(f.root, 'health-body'), '{"status":"ok"}\n')
    if (failure === 'capability-missing') writeFileSync(join(f.root, 'health-body'), '{"version":"0.11.0"}\n')
    if (failure === 'capability-false')
      writeFileSync(join(f.root, 'health-body'), '{"version":"0.11.0","custom_kernel":false}\n')
    if (failure === 'main-pid') writeFileSync(join(f.root, 'main-pid'), '0\n')
    if (failure === 'listener-pid') writeFileSync(join(f.root, 'listener-pid'), '5678\n')

    const result = f.run(kernelDeployment(f.kernel).enforce)

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
    assert.equal(readFileSync(f.env, 'utf8'), previousEnv)
    assert.equal(readFileSync(f.dropin, 'utf8'), previousDropin)
    assert.equal(statSync(f.env).mode & 0o777, 0o640)
    assert.equal(statSync(f.dropin).mode & 0o777, 0o600)
    assert.equal((f.events().match(/^restart /gm) ?? []).length, 2)
    if (failure !== 'restart') {
      const probes = failure.endsWith('-pid') ? 0 : 30
      assert.equal((f.events().match(/^probe /gm) ?? []).length, probes)
      assert.equal((f.events().match(/^sleep 2$/gm) ?? []).length, 30)
    }
  })
}

test('kernel activation waits for a healthy runner before accepting the new configuration', (t) => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'health-failures'), '2\n')
  const result = f.run(kernelDeployment(f.kernel).enforce)
  assert.equal(result.status, 0, result.stderr)
  assert.equal((f.events().match(/^probe /gm) ?? []).length, 3)
  assert.equal((f.events().match(/^sleep 2$/gm) ?? []).length, 2)
  assert.equal((f.events().match(/^restart /gm) ?? []).length, 1)
})

test('host convergence preserves a newer binary while updating its environment and kernel', (t) => {
  const f = fixture(t)
  for (const name of ['local-bin/boxlite-runner', 'units/boxlite-runner.service']) {
    const path = join(f.root, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'existing runner')
    chmodSync(path, 0o755)
  }
  mkdirSync(dirname(f.env), { recursive: true })
  const runnerEnv = join(f.root, 'etc/runner.env')
  writeFileSync(runnerEnv, 'BOXLITE_API_URL=https://previous.example.test/api\n')
  writeFileSync(join(f.root, 'identity'), '0.11.0\n')
  const result = f.run(
    renderHostConvergence({
      identity: '0.10.7',
      port: 4123,
      kernel: f.kernel,
      apiUrl: 'https://api.example.test',
      binary: {
        identity: '0.10.7',
        tarballName: 'runner.tar.gz',
        tarballUrl: 'https://example.test/runner.tar.gz',
        checksumUrl: 'https://example.test/runner.sha256',
        transport: 'https',
        source: 'release',
      },
    }),
  )

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /refusing to downgrade/)
  assert.equal(readFileSync(runnerEnv, 'utf8'), 'BOXLITE_API_URL=https://api.example.test/api\n')
  assert.deepEqual(readFileSync(f.path), f.payload)
  assert.equal(readFileSync(join(f.root, 'local-bin/boxlite-runner'), 'utf8'), 'existing runner')
  assert.doesNotMatch(f.events(), /^stop /m)
  assert.equal((f.events().match(/^restart /gm) ?? []).length, 2)
  assert.doesNotMatch(f.events(), /127\.0\.0\.1:3003/)
  assert.match(f.events(), /--write-out.*127\.0\.0\.1:4123\//)
  assert.match(f.events(), /^ss -H -ltnp sport = :4123$/m)
})

test('host convergence stops before the live runner when its binary backup fails', (t) => {
  const f = fixture(t)
  const binary = join(f.root, 'local-bin/boxlite-runner')
  const unit = join(f.root, 'units/boxlite-runner.service')
  mkdirSync(dirname(binary), { recursive: true })
  mkdirSync(dirname(unit), { recursive: true })
  writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(unit, '')
  const archive = join(f.root, 'download-runner.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', dirname(binary), 'boxlite-runner'])
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex')
  writeFileSync(join(f.root, 'download-runner.sha256'), `${digest}  runner.tar.gz\n`)
  writeFileSync(join(f.root, 'identity'), '0.9.0\n')
  const cp = execFileSync('sh', ['-c', 'command -v cp'], { encoding: 'utf8' }).trim()
  writeFileSync(
    join(f.root, 'bin/cp'),
    `#!/bin/bash
if [[ "$*" == *boxlite-runner.bak* ]]; then echo backup-failed >> "$TEST_ROOT/events"; exit 1; fi
exec '${cp}' "$@"
`,
    { mode: 0o755 },
  )

  const result = f.run(
    renderHostConvergence({
      identity: '0.10.7',
      port: 3003,
      kernel: f.kernel,
      binary: {
        identity: '0.10.7',
        tarballName: 'runner.tar.gz',
        tarballUrl: 'https://example.test/runner.tar.gz',
        checksumUrl: 'https://example.test/runner.sha256',
        transport: 'https',
        source: 'release',
      },
    }),
  )

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
  assert.match(f.events(), /^backup-failed$/m)
  assert.doesNotMatch(f.events(), /^(stop|start|restart) /m)
  assert.equal(readFileSync(binary, 'utf8'), '#!/bin/sh\nexit 0\n')
})

for (const enabled of [true, false]) {
  test(`AWS update and GCP policy install a changed kernel on an active ${enabled ? 'enabled' : 'disabled'} runner`, (t) => {
    const f = fixture(t)
    if (!enabled) writeFileSync(join(f.root, 'disabled'), '')
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
}

test('kernel enforcement updates an active runner even when disabled at boot', (t) => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'disabled'), '')
  const result = f.run(kernelDeployment(f.kernel).enforce)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readFileSync(f.path), f.payload)
  assert.equal((f.events().match(/^restart /gm) ?? []).length, 1)
})

test('unit environment converges for an active runner disabled at boot', (t) => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'disabled'), '')
  const path = join(f.root, 'etc/runner.env')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'BOXLITE_API_URL=https://previous.example.test/api\n')
  const scripts = renderUnitEnvironmentPolicyScripts({ apiUrl: 'https://api.example.test' })
  assert.equal(f.run(scripts.validate).status, 101)
  const result = f.run(scripts.enforce)
  assert.equal(result.status, 100, result.stderr)
  assert.equal(readFileSync(path, 'utf8'), 'BOXLITE_API_URL=https://api.example.test/api\n')
  assert.equal((f.events().match(/^restart /gm) ?? []).length, 1)
})

test('kernel enforcement leaves a disabled inactive bootstrap alone', (t) => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'disabled'), '')
  writeFileSync(join(f.root, 'inactive'), '')
  assert.equal(f.run(kernelDeployment(f.kernel).enforce).status, 0)
  assert.doesNotMatch(f.events(), /download|restart|daemon-reload/)
  assert.equal(existsSync(f.env), false)
})

for (const first of ['install', 'enforce'] as const) {
  for (const second of ['install', 'enforce'] as const) {
    test(`kernel ${first} excludes concurrent ${second} and releases its lock`, { timeout: 15_000 }, async (t) => {
      const f = fixture(t)
      const scripts = kernelDeployment(f.kernel)
      const otherPayload = Buffer.from('another verified kernel')
      const otherKernel = {
        url: 'https://example.test/other.bin',
        sha256: createHash('sha256').update(otherPayload).digest('hex'),
      }
      writeFileSync(join(f.root, 'download-other.bin'), otherPayload)
      const competing = kernelDeployment(otherKernel)[second]
      const child = spawn('bash', ['-c', f.localize(scripts[first])], {
        env: { ...f.environment, PAUSE_DOWNLOAD: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10_000,
      })
      const closed = once(child, 'close')
      let stderr = ''
      child.stderr.on('data', (data) => {
        stderr += data
      })
      try {
        const [ready] = await once(child.stdout, 'data')
        assert.match(String(ready), /kernel-download-paused/)
        const events = f.events()
        const concurrent = f.run(competing)
        assert.equal(concurrent.status, 1, 'a competing kernel transaction must fail')
        assert.match(concurrent.stderr, /kernel update already in progress/)
        const mutations = (log: string) =>
          log.split('\n').filter((line) => /^(download|restart|stop|daemon-reload)/.test(line))
        assert.deepEqual(mutations(f.events()), mutations(events), 'the contender must not write or restart the runner')
        assert.equal(existsSync(f.env), false)
      } finally {
        child.stdin.end('continue\n')
        const [status] = await closed
        assert.equal(status, 0, stderr)
      }
      assert.equal(f.run(competing).status, 0, 'the completed transaction must release its lock')
      assert.deepEqual(readFileSync(f.path), f.payload)
      assert.deepEqual(readFileSync(join(f.root, 'opt/kernels', otherKernel.sha256, 'kernel.bin')), otherPayload)
    })
  }
}

for (const failure of ['download', 'restart']) {
  test(`kernel ${failure} failure releases its lock for retry`, (t) => {
    const f = fixture(t)
    const scripts = kernelDeployment(f.kernel)
    const fault = join(f.root, `fail-${failure}`)
    writeFileSync(fault, '')
    assert.equal(f.run(scripts.enforce).status, 1)
    rmSync(fault, { force: true })
    assert.equal(f.run(scripts.enforce).status, 0)
    assert.deepEqual(readFileSync(f.path), f.payload)
  })
}

for (const failure of ['restore-env', 'restore-dropin', 'remove-dropin', 'daemon-reload', 'restart']) {
  test(`kernel rollback continues after ${failure} fails and retains its complete backup`, (t) => {
    const f = fixture(t)
    const previousEnv = 'BOXLITE_KERNEL_PATH=/previous/kernel.bin\n'
    const previousDropin = '[Service]\nEnvironmentFile=/previous/kernel.env\n'
    mkdirSync(dirname(f.env), { recursive: true })
    mkdirSync(dirname(f.dropin), { recursive: true })
    writeFileSync(f.env, previousEnv, { mode: 0o640 })
    if (failure !== 'remove-dropin') writeFileSync(f.dropin, previousDropin, { mode: 0o600 })
    writeFileSync(join(f.root, 'fail-health'), '')
    writeFileSync(join(f.root, `fail-rollback-${failure}`), '')
    for (const command of ['cp', 'mv', 'rm']) {
      const real = execFileSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).trim()
      writeFileSync(
        join(f.root, 'bin', command),
        `#!/bin/bash
source_path=\${@: -2:1}
destination=\${@: -1}
action=''
if [[ "$source_path" == "$TEST_ROOT/tmp/"* ]]; then
  if [ "$destination" = "$TEST_ROOT/etc/kernel.env" ]; then action=restore-env; fi
  if [ "$destination" = "$TEST_ROOT/units/boxlite-runner.service.d/kernel.conf" ]; then action=restore-dropin; fi
fi
if [ '${command}' = rm ] && [ "$destination" = "$TEST_ROOT/units/boxlite-runner.service.d/kernel.conf" ]; then action=remove-dropin; fi
if [ -n "$action" ]; then
  touch "$TEST_ROOT/rollback-started"
  echo "$action" >> "$TEST_ROOT/events"
  [ ! -e "$TEST_ROOT/fail-rollback-$action" ] || exit 1
fi
exec '${real}' "$@"
`,
        { mode: 0o755 },
      )
    }

    const result = f.run(kernelDeployment(f.kernel).enforce)

    assert.equal(result.status, 1)
    assert.match(f.events(), /restore-env/)
    assert.match(f.events(), failure === 'remove-dropin' ? /remove-dropin/ : /restore-dropin/)
    assert.equal((f.events().match(/^daemon-reload$/gm) ?? []).length, 2)
    assert.equal((f.events().match(/^restart /gm) ?? []).length, 2)
    if (failure !== 'restore-env') assert.equal(readFileSync(f.env, 'utf8'), previousEnv)
    if (failure !== 'restore-dropin' && failure !== 'remove-dropin') {
      assert.equal(readFileSync(f.dropin, 'utf8'), previousDropin)
    }
    assert.match(result.stderr, /rollback incomplete; backup retained at /)
    const backup = result.stderr.match(/backup retained at (.+)/)?.[1]
    assert.ok(backup)
    assert.equal(readFileSync(join(backup, 'kernel.env'), 'utf8'), previousEnv)
    assert.equal(statSync(join(backup, 'kernel.env')).mode & 0o777, 0o640)
    if (failure !== 'remove-dropin') assert.equal(readFileSync(join(backup, 'kernel.conf'), 'utf8'), previousDropin)
    assert.doesNotMatch(result.stderr, /restored previous configuration/)
  })
}

test('deployment rejects malformed digests and shell-bearing URLs before rendering', () => {
  for (const kernel of [
    { url: 'https://example.test/$(id)', sha256: 'a'.repeat(64) },
    { url: 'http://example.test/kernel', sha256: 'a'.repeat(64) },
    { url: 'https://example.test/kernel', sha256: 'a'.repeat(63) },
  ])
    assert.throws(() => kernelDeployment(kernel), /HTTPS asset URL/)
})

for (const [label, port] of [
  ['NaN', NaN],
  ['zero', 0],
  ['out-of-range', 65_536],
  ['fractional', 3003.5],
  ['shell-bearing', "3003'; id; #"],
] as const) {
  test(`deployment rejects ${label} health port before rendering`, () => {
    assert.throws(() => kernelDeployment(undefined, port as number), /health port.*1 to 65535/)
  })
}
