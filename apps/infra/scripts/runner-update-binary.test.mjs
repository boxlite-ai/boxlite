// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { liveText } from './live-source.mjs'

import {
  buildRemoteScript,
  PAYLOAD_WORST_CASE_SECONDS,
  payloadWorstCaseSeconds,
  resolveTargets,
  resolveUpgrade,
  resolveVersion,
  sendCommand,
  ssmSupervisionSeconds,
  TERMINAL_SSM_STATUSES,
  waitForTerminalStatus,
} from './runner-update-binary.mjs'

const assertShellLine = (run, pattern) => assert.match(liveText('shell', run), pattern)

const VERSION = '1.2.3'
const TARBALL = `boxlite-runner-v${VERSION}-linux-amd64.tar.gz`
const REF = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const BUCKET = 'boxlite-dev-artifacts-123456789012'
// The module reads its region once at import; mirror that rather than assume a default.
const REGION = process.env.AWS_REGION || 'ap-southeast-1'

// Both upgrades come out of the production resolver rather than hand-built literals, so a change
// to how a source is turned into an artifact reaches every payload assertion below.
const releaseUpgrade = (version = VERSION) => resolveUpgrade(['node', 'script', version], {})
const buildUpgrade = (version = VERSION) =>
  resolveUpgrade(
    ['node', 'script'],
    {
      RUNNER_ARTIFACT_SOURCE: 'build',
      BOXLITE_ARTIFACT_REF: REF,
      RUNNER_ARTIFACT_BUCKET: BUCKET,
      // Deliberately different: build identity must come from the artifact checkout, not this
      // legacy release override.
      RUNNER_VERSION: '9.9.9',
    },
    { readVersion: () => version },
  )

test('resolveVersion prefers the positional argument, then the environment', () => {
  assert.equal(resolveVersion(['node', 'script', '1.2.3'], { RUNNER_VERSION: '9.9.9' }), '1.2.3')
  assert.equal(resolveVersion(['node', 'script'], { RUNNER_VERSION: '4.5.6' }), '4.5.6')
})

test('resolveVersion strips a leading v so operators can paste a tag name', () => {
  assert.equal(resolveVersion(['node', 'script', 'v1.2.3'], {}), '1.2.3')
  assert.equal(resolveVersion(['node', 'script', '  v1.2.3  '], {}), '1.2.3')
})

test('resolveVersion falls back to the workspace version', () => {
  assert.match(resolveVersion(['node', 'script'], {}), /^\d+\.\d+\.\d+/)
})

test('release resolution shares VERSION with the API unless the Runner override is explicit', () => {
  const selected = resolveUpgrade(['node', 'script'], {
    RUNNER_ARTIFACT_SOURCE: 'release',
    VERSION: '8.7.6',
  })
  assert.equal(selected.version, '8.7.6')
  assert.match(selected.artifact.tarballUrl, /\/v8\.7\.6\/boxlite-runner-v8\.7\.6-linux-amd64\.tar\.gz$/)

  const runnerOverride = resolveUpgrade(['node', 'script'], {
    RUNNER_ARTIFACT_SOURCE: 'release',
    VERSION: '8.7.6',
    RUNNER_VERSION: '7.6.5',
  })
  assert.equal(runnerOverride.version, '7.6.5')

  const positional = resolveUpgrade(['node', 'script', '6.5.4'], {
    RUNNER_ARTIFACT_SOURCE: 'build',
    RUNNER_VERSION: '7.6.5',
  })
  assert.equal(positional.kind, 'release')
  assert.equal(positional.version, '6.5.4')
})

test('resolveTargets parses an explicit instance list without calling AWS', () => {
  const describe = () => assert.fail('AWS must not be consulted when INSTANCE_IDS is set')
  assert.deepEqual(resolveTargets({ INSTANCE_IDS: 'i-1,i-2' }, { describe }), ['i-1', 'i-2'])
  assert.deepEqual(resolveTargets({ INSTANCE_IDS: ' i-1 , , i-2 ' }, { describe }), ['i-1', 'i-2'])
})

test('resolveTargets orders discovered instances so a roll is reproducible', () => {
  // describe-instances promises no order, and an explicit list keeps the operator's.
  const describe = () => 'i-0c\ti-0a\ti-0b'
  assert.deepEqual(resolveTargets({}, { describe }), ['i-0a', 'i-0b', 'i-0c'])
  assert.deepEqual(resolveTargets({ INSTANCE_IDS: 'i-0c,i-0a' }, { describe }), ['i-0c', 'i-0a'])
})

test('resolveTargets rejects an empty discovery rather than silently doing nothing', () => {
  assert.throws(() => resolveTargets({}, { describe: () => 'None' }), /no running instances tagged/)
})

test('a version with no publishable release is refused on the deployer', () => {
  // Delegated to the shared resolver, so an unreleasable target fails here rather than
  // 404-ing on the runner.
  assert.throws(() => releaseUpgrade('0.9.8-alpha'), /not a stable semantic version/)
})

test('a build-mode upgrade installs the staged object, fetched with the instance role', () => {
  const upgrade = buildUpgrade()
  const script = buildRemoteScript(upgrade)
  const object = `s3://${BUCKET}/runner/${REF}/boxlite-runner-v${VERSION}-${REF}-linux-amd64.tar.gz`
  const aws = `aws --cli-connect-timeout 10 --cli-read-timeout 300 s3 cp --region ${REGION}`

  assert.equal(upgrade.kind, 'build')
  assert.ok(script.includes(`${aws} "${object}" "$WORK/runner.tar.gz"`), 'fetches the tarball')
  assert.ok(script.includes(`${aws} "${object}.sha256"`), 'fetches the checksum sidecar')
  assert.ok(
    !script.includes(`curl --fail --silent --show-error --location --proto`),
    'the artifact never comes over public HTTPS',
  )
  // SSM is the only channel that reaches a host whose user-data is ignored, so the payload has
  // to be able to install the CLI it is about to use.
  // Over the live payload: the string and the fetch below both survive a `#`, so the ordering
  // would otherwise hold over a script that no longer installs anything.
  const liveScript = liveText('shell', script)
  assert.ok(liveScript.includes('if ! command -v aws >/dev/null 2>&1; then'), 'installs a missing AWS CLI')
  // set -e aborts the payload on a failed curl/unzip/install, so without the trap each failed
  // upgrade leaves a temp directory behind on a host that lives for months.
  assertShellLine(liveScript, /trap 'rm -rf "\$CLI_WORK"' EXIT/)
  assert.ok(
    liveScript.indexOf(`trap 'rm -rf "$CLI_WORK"' EXIT`) < liveScript.indexOf('curl --fail'),
    'the trap must be armed before anything that can abort',
  )
  assert.ok(
    liveScript.indexOf('command -v aws') < liveScript.indexOf(aws),
    'the CLI is ensured before the first command that needs it',
  )
  // Everything after the fetch is the release path's, unchanged.
  assert.ok(script.includes('FATAL: checksum mismatch'), 'still fails closed on a bad digest')
  assert.ok(script.includes('still bootstrapping'), 'still leaves a bootstrapping host alone')
})

test('a build-mode upgrade is identified by its commit, not by the version it shares', () => {
  // Two commits of one checkout report the same X.Y.Z, so a version-only identity would make
  // the "already at target" guard skip every dev deploy after the first.
  assert.equal(buildUpgrade().expectedVersion, `${VERSION}+${REF}`)
  assert.ok(buildRemoteScript(buildUpgrade()).includes(`TARGET="${VERSION}+${REF}"`))
})

test('a build ref from another workspace version resolves a different object before touching a host', () => {
  const old = buildUpgrade('1.2.3')
  const current = buildUpgrade('1.2.4')

  assert.match(old.artifact.tarballUrl, new RegExp(`/boxlite-runner-v1\\.2\\.3-${REF}-linux-amd64\\.tar\\.gz$`))
  assert.match(current.artifact.tarballUrl, new RegExp(`/boxlite-runner-v1\\.2\\.4-${REF}-linux-amd64\\.tar\\.gz$`))
  assert.notEqual(old.artifact.tarballUrl, current.artifact.tarballUrl)
  assert.equal(current.expectedVersion, `1.2.4+${REF}`)
})

test('the deployer supervises for longer than the payload it started can take', () => {
  // Nothing cancels an accepted SSM command. If the deployer gave up first it would report
  // failure while the host went on to stop the unit and swap the binary — the worst outcome
  // available, because the roll halts believing it did nothing.
  //
  // The bounded steps are a floor: apt-get, unzip and the CLI installer take no timeout. Require
  // real slack over that floor rather than a bare inequality, so the unbounded remainder has
  // somewhere to live.
  assert.ok(
    ssmSupervisionSeconds() > payloadWorstCaseSeconds() * 2,
    `supervision ${ssmSupervisionSeconds()}s needs slack over the ${payloadWorstCaseSeconds()}s bounded floor`,
  )

  // The bounds are the ones actually emitted into the payload, so raising a fetch timeout past
  // the supervision window fails here rather than in production.
  const script = buildRemoteScript(buildUpgrade())
  assert.match(script, new RegExp(`--max-time ${PAYLOAD_WORST_CASE_SECONDS.awsCliInstall}`))
  assert.match(script, new RegExp(`--cli-read-timeout ${PAYLOAD_WORST_CASE_SECONDS.tarballFetch}`))
  assert.match(buildRemoteScript(releaseUpgrade()), new RegExp(`--max-time ${PAYLOAD_WORST_CASE_SECONDS.tarballFetch}`))
  // The readiness gate is 30 attempts two seconds apart.
  assert.match(script, /for _ in \$\(seq 1 30\); do/)
  assert.equal(PAYLOAD_WORST_CASE_SECONDS.readinessGate, 60)
})

test('a build-mode upgrade carries no version-ordering guard', () => {
  // Two commits are neither older nor newer than each other; refusing one as a "downgrade"
  // would silently do nothing on exactly the deploy that asked for it.
  const script = buildRemoteScript(buildUpgrade())
  assert.ok(!script.includes('live_is_newer'), 'no ordering comparison')
  assert.ok(!liveText('shell', script).includes('refusing to downgrade'), 'nothing to refuse')
  // The release path's whole reason for deploy-release.yml's allow_downgrade input: read it live,
  // since the message survives a `#` while the comparison that emits it stops running.
  const liveReleaseScript = liveText('shell', buildRemoteScript(releaseUpgrade()))
  // Pin the branch, not its message: both sit on one line, so the message alone proves nothing
  // about whether the guard still evaluates.
  assert.match(liveReleaseScript, /if \[ "\$\{ALLOW_DOWNGRADE:-\}" != "1" \] && live_is_newer; then/)
  assert.match(liveReleaseScript, /^live_is_newer\(\) \{/m)
  assert.ok(liveReleaseScript.includes('refusing to downgrade'), 'releases still guard')
})

test('buildRemoteScript points at the shared release URLs', () => {
  const script = buildRemoteScript(releaseUpgrade())
  assert.ok(script.includes(`/v${VERSION}/${TARBALL}"`), 'fetches the tarball')
  assert.ok(script.includes(`/v${VERSION}/${TARBALL}.sha256"`), 'fetches the checksum sidecar')
})

test('buildRemoteScript fails closed when the checksum is missing or mismatched', () => {
  const script = buildRemoteScript(releaseUpgrade())
  assert.ok(script.includes('FATAL: checksum manifest does not name'), 'absent sidecar is fatal')
  // Over the live script: the message and the `systemctl stop` below both survive a `#`, so the
  // ordering alone would hold over a payload whose comparison no longer runs.
  const liveScript = liveText('shell', script)
  assert.match(liveScript, /\[ "\$EXPECTED" = "\$ACTUAL" \]/, 'the digest comparison must still run')
  assert.ok(liveScript.includes('FATAL: checksum mismatch'), 'mismatched digest is fatal')
  // Integrity must be settled before the running service is touched.
  assert.ok(
    liveScript.indexOf('FATAL: checksum mismatch') < liveScript.indexOf('systemctl stop'),
    'verification precedes stopping the unit',
  )
})

test('the checksum manifest must name the tarball literally, not by pattern', () => {
  const payload = buildRemoteScript(releaseUpgrade())
  const awkLine = payload.split('\n').find((line) => line.startsWith('EXPECTED='))
  assert.ok(awkLine.includes('\\.'), 'dots are escaped so they are not ERE wildcards')

  // Run the emitted extraction against manifests the real world could hand us.
  const extract = (manifest) =>
    spawnSync(
      'bash',
      [
        '-c',
        `WORK=$(mktemp -d); printf '%s\\n' "$1" > "$WORK/runner.sha256"; ${awkLine}; echo "$EXPECTED"`,
        'test',
        manifest,
      ],
      { encoding: 'utf8' },
    ).stdout.trim()

  const digest = 'b'.repeat(64)
  assert.equal(extract(`${digest}  ${TARBALL}`), digest, 'plain manifest')
  assert.equal(extract(`${digest} *${TARBALL}`), digest, 'binary-mode marker')
  assert.equal(extract(`${digest}  other.tar.gz`), '', 'a different asset is rejected')
  assert.equal(extract(`${digest}  ${TARBALL}.sig`), '', 'a suffixed name is rejected')
  assert.equal(extract(`${digest}  ${TARBALL.replaceAll('.', 'X')}`), '', 'dots are not wildcards')
  assert.equal(extract(''), '', 'an empty manifest yields nothing')
})

test('buildRemoteScript leaves a still-bootstrapping host alone', () => {
  const script = liveText('shell', buildRemoteScript(releaseUpgrade()))
  assert.ok(script.includes('still bootstrapping'))
  assert.ok(script.indexOf('still bootstrapping') < script.indexOf('CURRENT=$(probe_version'))
})

test('buildRemoteScript threads ALLOW_DOWNGRADE through to the host', () => {
  assert.ok(buildRemoteScript(releaseUpgrade()).includes('ALLOW_DOWNGRADE=""'))
  assert.ok(buildRemoteScript(releaseUpgrade(), { allowDowngrade: true }).includes('ALLOW_DOWNGRADE="1"'))
})

test('buildRemoteScript honours a non-default runner port', () => {
  assert.ok(buildRemoteScript(releaseUpgrade(), { runnerPort: '3100' }).includes('http://127.0.0.1:3100/'))
})

test('buildRemoteScript rejects a non-numeric runner port on the deployer', () => {
  // The port lands verbatim in the remote script body, so a typo should fail here
  // rather than obscurely inside a curl on the host.
  for (const bad of ['80 80', 'http://x', '', '3003;id']) {
    assert.throws(() => buildRemoteScript(releaseUpgrade(), { runnerPort: bad }), /RUNNER_PORT must be numeric/)
  }
})

test('the payload never asks the binary for its version', () => {
  // The Go runner parses no CLI args, so `boxlite-runner --version` starts a second
  // process that exits non-zero — which is what made the old script report a failed
  // SSM run after a successful upgrade. The health route is the only version oracle.
  const script = buildRemoteScript(releaseUpgrade())
  assert.ok(!/boxlite-runner\s+--version/.test(script), 'must not invoke --version')
  assert.ok(script.includes('probe_version()'), 'reads the version from the health route instead')
})

test('a non-terminal SSM status keeps polling instead of becoming a verdict', () => {
  // `aws ssm wait command-executed` gives up after 100s with InProgress still retryable,
  // so anything that reads its result as an outcome aborts healthy long upgrades.
  assert.deepEqual([...TERMINAL_SSM_STATUSES].sort(), ['Cancelled', 'Failed', 'Success', 'TimedOut'])

  const seen = []
  const statuses = ['Pending', 'InProgress', 'Delayed', 'Success']
  const run = () => {
    const stdout = statuses[seen.length]
    seen.push(stdout)
    return { ok: true, stdout, stderr: '' }
  }
  assert.equal(waitForTerminalStatus([], 'i-1', { run, sleep: () => {} }), 'Success')
  assert.deepEqual(seen, statuses, 'polled through every non-terminal status')
})

test('a persistent polling failure surfaces its cause, not a bare timeout', () => {
  // Otherwise a denied permission is indistinguishable from a slow upgrade — the exact
  // "a failed SSM run discarded its own diagnostics" fault this script exists to avoid.
  const run = () => ({ ok: false, stdout: '', stderr: 'An error occurred (AccessDeniedException)' })
  assert.throws(() => waitForTerminalStatus([], 'i-1', { run, sleep: () => {} }), /AccessDeniedException/)
})

test('a stalled-but-healthy command reports the status it was stuck on', () => {
  const run = () => ({ ok: true, stdout: 'InProgress', stderr: '' })
  assert.throws(() => waitForTerminalStatus([], 'i-1', { run, sleep: () => {} }), /last status: InProgress/)
})

test('a recovered transient poll error does not outlive the stall it preceded', () => {
  // InvocationDoesNotExist right after send-command is expected. If it were never
  // cleared it would outrank every later InProgress poll and blame a failure that had
  // already resolved.
  let call = 0
  const run = () => {
    call += 1
    return call === 1
      ? { ok: false, stdout: '', stderr: 'InvocationDoesNotExist' }
      : { ok: true, stdout: 'InProgress', stderr: '' }
  }
  assert.throws(() => waitForTerminalStatus([], 'i-1', { run, sleep: () => {} }), /last status: InProgress/)
})

test('sendCommand retries throttling as well as an unregistered agent', () => {
  // Losing a whole roll to a rate limit would strand the fleet half-upgraded.
  for (const transient of ['ThrottlingException', 'RequestLimitExceeded', 'TooManyUpdates']) {
    let calls = 0
    const run = () => {
      calls += 1
      return calls === 1 ? { ok: false, stdout: '', stderr: transient } : { ok: true, stdout: 'cmd-1', stderr: '' }
    }
    assert.equal(sendCommand('i-1', VERSION, 'x', { run, sleep: () => {} }), 'cmd-1', transient)
    assert.equal(calls, 2, `${transient} should have been retried once`)
  }
})

test('sendCommand hands SSM a base64 payload with no shell metacharacters', () => {
  // Nothing else pins the argv, and the whole reason for base64 is that the payload
  // becomes a single token inside the commands=[...] shorthand.
  let seen
  const run = (args) => {
    seen = args
    return { ok: true, stdout: 'cmd-1', stderr: '' }
  }
  const script = buildRemoteScript(releaseUpgrade())
  sendCommand('i-42', VERSION, Buffer.from(script).toString('base64'), { run, sleep: () => {} })

  const flag = (name) => seen[seen.indexOf(name) + 1]
  assert.deepEqual(seen.slice(0, 2), ['ssm', 'send-command'])
  assert.equal(flag('--document-name'), 'AWS-RunShellScript')
  assert.equal(flag('--instance-ids'), 'i-42')
  assert.equal(flag('--query'), 'Command.CommandId')

  const parameters = flag('--parameters')
  const encoded = parameters.match(/^commands=\["echo ([A-Za-z0-9+/=]+) \| base64 -d \| bash"\]$/)
  assert.ok(encoded, `unexpected --parameters shape: ${parameters}`)
  // Exact string equality, not a decode round-trip: Node's base64 decoder tolerates
  // trailing junk, so `${payload}X` would still decode back to the original script.
  assert.equal(encoded[1], Buffer.from(script).toString('base64'), 'the payload reaches SSM intact')
})

test('sendCommand retries an unregistered agent but not a permission failure', () => {
  const slept = []
  const sleep = (seconds) => slept.push(seconds)

  let calls = 0
  const flaky = () => {
    calls += 1
    return calls < 3
      ? { ok: false, stdout: '', stderr: 'An error occurred (InvalidInstanceId) when calling SendCommand' }
      : { ok: true, stdout: 'cmd-1', stderr: '' }
  }
  assert.equal(sendCommand('i-1', VERSION, 'cGF5bG9hZA==', { run: flaky, sleep }), 'cmd-1')
  assert.equal(calls, 3, 'retried until the agent registered')
  assert.deepEqual(slept, [10, 10])

  let denied = 0
  const refuse = () => {
    denied += 1
    return { ok: false, stdout: '', stderr: 'An error occurred (AccessDeniedException) when calling SendCommand' }
  }
  assert.throws(() => sendCommand('i-2', VERSION, 'x', { run: refuse, sleep }), /AccessDeniedException/)
  assert.equal(denied, 1, 'a non-registration error fails immediately')
})

test('runs as a script from a path that needs percent-encoding', (t) => {
  // `file://${argv[1]}` never equals import.meta.url once the path contains a space, so
  // the old guard skipped main() and exited 0 — the roll silently did nothing while the
  // Pulumi command reported success. Invoke the real file from such a path and require
  // that it actually got as far as needing the aws CLI.
  const root = mkdtempSync(join(tmpdir(), 'boxlite runner update '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const scriptDirectory = fileURLToPath(new URL('.', import.meta.url))
  const copied = join(root, 'scripts')
  cpSync(scriptDirectory, copied, { recursive: true })
  // The copies still import dotenv; point module resolution at the real dependencies
  // without moving the script back out of the spaced path.
  symlinkSync(join(scriptDirectory, '..', 'node_modules'), join(root, 'node_modules'), 'dir')

  const result = spawnSync(process.execPath, [join(copied, 'runner-update-binary.mjs'), VERSION], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '/nonexistent', INSTANCE_IDS: 'i-1' },
  })

  assert.equal(result.status, 1, `expected the roll to run and fail on the missing CLI:\n${result.stdout}`)
  assert.match(result.stderr, /aws` CLI is required/)
})

const bash = (script, args = []) => spawnSync('bash', ['-c', script, 'test', ...args], { encoding: 'utf8' })

test('the generated payload is valid bash', () => {
  const check = spawnSync('bash', ['-n'], { input: buildRemoteScript(releaseUpgrade()), encoding: 'utf8' })
  assert.equal(check.status, 0, check.stderr)
})

test('live_is_newer orders releases and prereleases the way semver does', () => {
  // Runs the comparison the production payload actually carries, rather than a copy.
  const payload = buildRemoteScript(releaseUpgrade())
  const start = payload.indexOf('live_is_newer() {')
  assert.notEqual(start, -1, 'the payload no longer defines live_is_newer')
  const end = payload.indexOf('\n}\n', start)
  assert.notEqual(end, -1, 'live_is_newer is not closed by a top-level brace')
  const fn = payload.slice(start, end + 2)

  const cases = [
    ['0.9.8-alpha', '0.9.7', true], // a prerelease still outranks an older release
    ['0.9.7', '0.9.8-alpha', false],
    ['0.9.8-alpha', '0.9.8', false], // prerelease precedes its own release: upgrade it
    ['0.9.10', '0.9.9', true], // numeric, not lexical
    ['1.0.0', '0.9.99', true],
    ['', '0.9.7', false], // an unreachable probe is never "newer"
    // Semver ignores build metadata for precedence. Without stripping it, a release deploy
    // reads a dev build as newer and refuses to replace it — so the stage would be stuck on
    // whatever commit was last pushed to it.
    ['0.9.7+a1b2c3d', '0.9.7', false],
    ['0.9.8+a1b2c3d', '0.9.7', true],
    ['0.9.7+a1b2c3d', '0.9.8', false],
  ]

  for (const [current, target, expected] of cases) {
    const result = bash(`CURRENT="$1"; TARGET="$2"\n${fn}\nlive_is_newer && echo NEWER || echo older`, [
      current,
      target,
    ])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), expected ? 'NEWER' : 'older', `${current || '<empty>'} vs ${target}`)
  }
})
