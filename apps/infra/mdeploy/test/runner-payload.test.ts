/*
 * The host-side integrity gate, executed rather than read.
 *
 * These checks used to live in deployer-side TypeScript, where
 * `artifacts/runner.test.ts` proved them behaviourally against fake CLIs. They
 * now live in bash that a host runs as root, and a test that only matched the
 * rendered text would prove nothing about what that bash does — asserting the
 * escaped awk pattern is the test writing the pattern and then finding it.
 *
 * So the fragments are run. Both are self-contained by construction: the
 * verification needs two files, and the downgrade guard needs two variables.
 * What is deliberately not run here is the whole payload — it stops units and
 * talks to systemd — and the ordering claims about it stay in
 * `runner-upgrade.test.ts`, where ordering is all they are.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  renderHostConvergence,
  renderUnitEnvironmentPolicyScripts,
  renderUpgradePayload,
  type UpgradeTarget,
} from '../stack/runner-upgrade.ts'
import { renderRunnerBoot } from '../stack/runner-boot.ts'
import { verifyAgainstManifest } from '../stack/runner-binary.ts'

const TARBALL = 'boxlite-runner-v0.10.0-linux-amd64.tar.gz'

/** One bash fragment, run with `set -euo pipefail` as the payload runs it. */
const bash = (script: string): { code: number; out: string } => {
  try {
    const out = execFileSync('bash', ['-c', `set -euo pipefail\n${script}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out }
  } catch (error: any) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/** A tarball of known bytes and a manifest a caller writes however it likes. */
const fixture = (manifest: (digest: string) => string) => {
  const work = mkdtempSync(join(tmpdir(), 'runner-payload-'))
  const tarball = join(work, 'runner.tar.gz')
  writeFileSync(tarball, 'not really a tarball, but it hashes\n')
  const digest = execFileSync('shasum', ['-a', '256', tarball], { encoding: 'utf8' }).split(/\s+/)[0] as string
  const path = join(work, 'runner.sha256')
  writeFileSync(path, manifest(digest))
  return { tarball, manifest: path, digest }
}

/*
 * `sha256sum` is the name the host script calls, so running that script here
 * needs it here. Ubuntu ships it and every runner is Ubuntu; macOS does not.
 *
 * Skipped rather than adapted. The fixture above already uses the portable
 * `shasum` for its own digest, so only the code under test depends on the
 * name — and rewriting that to `shasum` would be testing a script no host
 * runs. A skip with a reason is what a developer can act on; the alternative
 * is `bash: sha256sum: command not found` inside a refusal message.
 */
const digestsLocally = (() => {
  try {
    execFileSync('sha256sum', ['--version'], { stdio: 'ignore' })
    return {}
  } catch {
    return { skip: 'sha256sum is absent here, and the host script calls it by name' }
  }
})()

const verify = (manifest: (digest: string) => string, tarballName = TARBALL) => {
  const files = fixture(manifest)
  return bash(verifyAgainstManifest({ tarballName, tarball: files.tarball, manifest: files.manifest }))
}

test('bytes that match the manifest are accepted', digestsLocally, () => {
  const result = verify((digest) => `${digest}  ${TARBALL}\n`)
  assert.equal(result.code, 0, result.out)
  assert.match(result.out, /checksum verified/)
})

test('the binary-mode asterisk sha256sum writes is part of the format', digestsLocally, () => {
  assert.equal(verify((digest) => `${digest} *${TARBALL}\n`).code, 0)
})

test('a manifest naming another file is refused, however valid its digest', digestsLocally, () => {
  // The case a digest comparison alone cannot catch, and the reason the awk
  // pattern is anchored on the filename at all.
  const result = verify((digest) => `${digest}  some-other-runner.tar.gz\n`)
  assert.equal(result.code, 1)
  assert.match(result.out, new RegExp(`does not name ${TARBALL.replace(/\./g, '\\.')}`))
})

test('the dots in the name are anchors, not wildcards', digestsLocally, () => {
  // Unescaped they match any character, so a differently-named asset would
  // satisfy the check. `boxlite-runner-v0X10X0-…` differs from the wanted name
  // only where a dot stands.
  const result = verify((digest) => `${digest}  boxlite-runner-v0X10X0-linux-amd64XtarXgz\n`)
  assert.equal(result.code, 1, 'a name that only matches with dots as wildcards was accepted')
})

test('an uppercase digest is refused rather than compared', digestsLocally, () => {
  // sha256sum emits lowercase, so an uppercase manifest would never match — and
  // failing on the shape says why, where a mismatch would blame the bytes.
  const result = verify((digest) => `${digest.toUpperCase()}  ${TARBALL}\n`)
  assert.equal(result.code, 1)
  assert.match(result.out, /no lowercase sha256/)
})

test('a digest of the wrong length is refused before the comparison', digestsLocally, () => {
  const result = verify(() => `${'a'.repeat(63)}  ${TARBALL}\n`)
  assert.equal(result.code, 1)
  assert.match(result.out, /not 64 hex characters/)
})

test('bytes that do not match the manifest are fatal', digestsLocally, () => {
  const result = verify(() => `${'b'.repeat(64)}  ${TARBALL}\n`)
  assert.equal(result.code, 1)
  assert.match(result.out, /runner checksum mismatch/)
})

test('an empty manifest is refused rather than read as "no digest wanted"', digestsLocally, () => {
  const result = verify(() => '')
  assert.equal(result.code, 1)
  assert.match(result.out, /does not name/)
})

// ── the downgrade guard ─────────────────────────────────────────────────────

const target = (overrides: Partial<UpgradeTarget> = {}): UpgradeTarget => ({
  identity: '0.10.0',
  binary: {
    tarballUrl: `https://example.invalid/${TARBALL}`,
    checksumUrl: `https://example.invalid/${TARBALL}.sha256`,
    tarballName: TARBALL,
    transport: 'https',
    source: 'release',
    identity: '0.10.0',
  },
  port: 3003,
  ...overrides,
})

/**
 * The guard alone, asked whether it would refuse.
 *
 * Lifted out of the payload by taking everything from `live_is_newer` up to the
 * refusal, because the rest of the payload probes a health route and talks to
 * systemd. `TARGET` and `CURRENT` are what it reads, and `echo ok` is what
 * running past it looks like.
 */
const guard = (current: string, wanted: string, { allowDowngrade = false } = {}) => {
  const payload = renderUpgradePayload(target({ identity: wanted, allowDowngrade }))
  const fragment = payload.slice(payload.indexOf('live_is_newer() {'), payload.indexOf('WORK=$(mktemp -d)'))
  return bash(`TARGET="${wanted}"\nCURRENT="${current}"\nALLOW_DOWNGRADE="${allowDowngrade ? '1' : ''}"\n${fragment}\necho ok`)
}

test('a host behind the target is upgraded', () => {
  for (const current of ['0.9.9', '0.9.10', '0.10.0-rc.1', '0.10.0+' + 'a'.repeat(40)]) {
    assert.match(guard(current, '0.10.0').out, /ok/, `${current} was refused as newer than 0.10.0`)
  }
})

test('a host ahead of the target is refused, and sort -V orders the cores correctly', () => {
  // `0.9.10` above `0.9.9` is the comparison a string sort gets backwards, and
  // the one a fleet numbered past nine actually hits.
  for (const [current, wanted] of [
    ['0.10.0', '0.9.9'],
    ['0.9.10', '0.9.9'],
    ['1.0.0', '0.99.99'],
  ]) {
    const result = guard(current as string, wanted as string)
    assert.match(result.out, /refusing to downgrade/, `${current} was allowed to be replaced by ${wanted}`)
    assert.doesNotMatch(result.out, /ok/, 'the refusal has to stop the payload, not warn and continue')
  }
})

test('a prerelease of the target is behind it, which semver requires and sort -V gets wrong', () => {
  // `sort -V` calls 0.9.8-alpha newer than 0.9.8; the guard applies "a
  // prerelease precedes its release" by hand, and this is that.
  assert.match(guard('0.10.0-alpha', '0.10.0').out, /ok/)
})

test('build metadata is ignored for precedence, so a dev build is replaceable', () => {
  // Semver ignores it. Without stripping, a release deploy would read
  // `0.10.0+abc` as newer than `0.10.0` and refuse to replace a dev build.
  assert.match(guard(`0.10.0+${'f'.repeat(40)}`, '0.10.0').out, /ok/)
})

test('a host that is not serving is never newer, so an unhealthy one is repaired', () => {
  assert.match(guard('', '0.10.0').out, /ok/)
})

test('the refusal is what --allow-downgrade lifts', () => {
  const forced = guard('0.10.0', '0.9.5', { allowDowngrade: true })
  assert.match(forced.out, /ok/)
  assert.doesNotMatch(forced.out, /refusing to downgrade/)
})

test('the same guard is absent in build mode, where there is no ordering', () => {
  const build = renderUpgradePayload(
    target({
      identity: `0.10.0+${'c'.repeat(40)}`,
      binary: { ...target().binary, source: 'build', identity: `0.10.0+${'c'.repeat(40)}` },
    }),
  )
  assert.doesNotMatch(build, /live_is_newer/)
})

test('the same rendered lines guard both install paths', () => {
  /*
   * One rendering, so first boot and every later upgrade cannot disagree about
   * what counts as the right bytes — which is the whole reason the fragment is
   * a function rather than two copies of the same bash.
   *
   * Asserted by finding the identical text in both renderings, because that is
   * the property: not that two functions agree, but that there is one.
   */
  const shared = verifyAgainstManifest({
    tarballName: TARBALL,
    tarball: '/tmp/boxlite-runner.tar.gz',
    manifest: '/tmp/boxlite-runner.sha256',
  })
  const boot = Buffer.from(
    renderRunnerBoot({
      apiUrl: 'https://api.invalid/',
      otlpUrl: 'http://collector:4318',
      binary: { tarballUrl: 'https://x/t.tar.gz', checksumUrl: 'https://x/t.tar.gz.sha256', tarballName: TARBALL, transport: 'https' },
      port: 3003,
      environment: {},
      platform: { hostAddress: 'HOST_IP=1', installVolumeMount: '', prepareKvm: '', startWrapper: null, unitEnvironment: {} },
    }),
    'base64',
  ).toString('utf8')
  assert.ok(boot.includes(shared), 'the boot script renders its own verification')

  const upgrade = renderUpgradePayload(target())
  const inUpgrade = verifyAgainstManifest({
    tarballName: TARBALL,
    tarball: '$WORK/runner.tar.gz',
    manifest: '$WORK/runner.sha256',
  })
  assert.ok(upgrade.includes(inUpgrade), 'the upgrade payload renders its own verification')
})

/*
 * The unit-environment scripts, run rather than read.
 *
 * Every one of them opens with `set -euo pipefail`, so a name that does not
 * exist is not a typo the reader spots — it is exit 1 from a branch whose whole
 * job is to answer "nothing to do". A rendered script that is only matched
 * against a pattern proves nothing about that, which is how a bare `$ENV_FILE`
 * survived a green suite: the text read correctly and the shell refused it.
 *
 * The bootstrapping branch is the one a workstation can reach — no runner host
 * here has `/etc/boxlite/runner.env` — and it is also the branch that must be
 * cheapest to be right, because every fresh instance passes through it.
 */
const ENVIRONMENT = { apiUrl: 'https://api.dev.boxlite.ai', volumeBackend: 'gcs' }

test('an OS policy answers "satisfied" on a host that has not written the file yet', () => {
  const { validate, enforce } = renderUnitEnvironmentPolicyScripts(ENVIRONMENT)
  for (const [name, script] of [
    ['validate', validate],
    ['enforce', enforce],
  ] as const) {
    const { code, out } = bash(script)
    assert.equal(code, 100, `${name} answered ${code} instead of satisfied: ${out}`)
    assert.match(out, /still bootstrapping/)
  }
})

test('a payload leaves a bootstrapping host alone rather than failing on it', () => {
  // The SSM half of the same claim. The binary part is not runnable here — it
  // talks to systemd — so what is run is the block that follows it, which is
  // where every name this module introduced lives.
  const payload = renderHostConvergence({
    identity: '0.10.0',
    binary: {
      tarballUrl: `https://example.invalid/${TARBALL}`,
      checksumUrl: `https://example.invalid/${TARBALL}.sha256`,
      tarballName: TARBALL,
      transport: 'https',
      source: 'release',
      identity: '0.10.0',
    },
    port: 3003,
    ...ENVIRONMENT,
  })
  assert.equal(bash(`bash -n <<'PAYLOAD'\n${payload}\nPAYLOAD`).code, 0, 'the whole payload must at least parse')

  const block = payload.slice(payload.indexOf('UNIT_ENV_FILE='))
  const { code, out } = bash(block)
  assert.equal(code, 0, `the unit-environment half exited ${code}: ${out}`)
  assert.match(out, /still bootstrapping/)
})

/*
 * The rewrite itself, on a file, with a systemd this test supplies.
 *
 * Everything above proves the branch that answers "nothing to do". This is the
 * other one: a host whose environment names a control plane the stage no longer
 * serves. What has to be true afterwards is not only that the line changed —
 * the file carries BOXLITE_RUNNER_TOKEN, so a converged host must be left
 * holding no second copy of it, and a fleet already converged must not restart
 * on the next cycle.
 */
const converge = ({ contents, work }: { contents: string; work: string }) => {
  const envFile = join(work, 'runner.env')
  writeFileSync(envFile, contents)
  // What `renderRunnerBoot` leaves behind: the file carries
  // BOXLITE_RUNNER_TOKEN, so it is not readable by anything else on the host.
  chmodSync(envFile, 0o640)
  const binDir = join(work, 'bin')
  if (!existsSync(binDir)) {
    mkdirSync(binDir)
    const systemctl = join(binDir, 'systemctl')
    // `is-enabled` answers yes; `restart` records that it was asked.
    writeFileSync(
      systemctl,
      ['#!/bin/sh', 'if [ "$1" = restart ]; then echo restart >> "$RESTARTS"; fi', 'exit 0', ''].join('\n'),
    )
    chmodSync(systemctl, 0o755)
  }
  const restarts = join(work, 'restarts')
  const { enforce } = renderUnitEnvironmentPolicyScripts({
    apiUrl: 'https://api.dev.boxlite.ai',
    otlpUrl: 'http://collector:4318',
    volumeBackend: 'gcs',
  })
  const result = spawnSync('bash', ['-c', enforce], {
    encoding: 'utf8',
    env: {
      PATH: `${binDir}:/usr/bin:/bin`,
      BOXLITE_RUNNER_ENV_FILE: envFile,
      RESTARTS: restarts,
    },
  })
  return {
    code: result.status,
    out: `${result.stdout}${result.stderr}`,
    file: readFileSync(envFile, 'utf8'),
    mode: statSync(envFile).mode & 0o777,
    leftovers: readdirSync(work).filter((name) => name.startsWith('runner.env.')),
    restarts: existsSync(restarts) ? readFileSync(restarts, 'utf8').trim().split('\n').length : 0,
    enforce,
  }
}

test('a host pointed at a name this stage no longer serves is rewritten once', () => {
  const work = mkdtempSync(join(tmpdir(), 'runner-unit-env-'))
  // What the prod hosts actually hold: an address from before the domain moved,
  // and the collector endpoint frozen empty by a first boot that had no collector.
  const stale =
    'BOXLITE_API_URL=https://dev.boxlite.ai/api\nOTEL_EXPORTER_OTLP_ENDPOINT=\nBOXLITE_RUNNER_TOKEN=secret-token\n'

  const first = converge({ contents: stale, work })
  assert.equal(first.code, 100, `enforce did not converge: ${first.out}`)
  assert.match(first.file, /^BOXLITE_API_URL=https:\/\/api\.dev\.boxlite\.ai\/api$/m, 'the address was not rewritten')
  assert.match(first.file, /^VOLUME_STORAGE_BACKEND=gcs$/m, 'the key the file lacked was not appended')
  // The key that was present but empty: `^key=` has to match it too, or the
  // host keeps the value that silences its exporter.
  assert.match(
    first.file,
    /^OTEL_EXPORTER_OTLP_ENDPOINT=http:\/\/collector:4318$/m,
    'the endpoint that froze empty was not filled in',
  )
  assert.match(first.file, /^BOXLITE_RUNNER_TOKEN=secret-token$/m, 'the rewrite dropped the host’s own token')
  /*
   * Nothing beside it, and nothing loosened.
   *
   * Both halves are about the same secret. A copy left behind — the backup, or
   * the temporary the rewrite writes through — is a second readable copy of
   * BOXLITE_RUNNER_TOKEN; and a rewrite that renamed a new file over this one
   * would carry the umask's mode onto it, which is 644 by default and the token
   * readable by every account on the host.
   */
  assert.deepEqual(first.leftovers, [], 'a file carrying the token was left beside it')
  assert.equal(first.mode, 0o640, 'the rewrite widened the mode the boot script set')
  // The temporary it writes through carries the same secret, so it is created
  // unreadable rather than at the umask's default — asserted through the shell
  // that makes it, because a `umask` in the wrong subshell reads as correct.
  assert.match(first.enforce, /\(umask 077; awk/, 'the temporary is written at the default umask')
  assert.equal(first.restarts, 1, 'the unit must be restarted exactly once')

  // And again, against what the first run produced: a converged fleet enforces
  // nothing, which is what keeps this off every deploy.
  const second = converge({ contents: first.file, work })
  assert.equal(second.code, 100)
  assert.equal(second.restarts, 1, 'a converged host was restarted a second time')
  assert.match(second.out, /already pointed at the current control plane/)
})
