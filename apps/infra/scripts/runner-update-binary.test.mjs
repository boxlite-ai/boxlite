// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
  buildRemoteScript,
  resolveTargets,
  resolveVersion,
  sendCommand,
  TERMINAL_SSM_STATUSES,
  waitForTerminalStatus,
} from './runner-update-binary.mjs'

const VERSION = '1.2.3'
const TARBALL = `boxlite-runner-v${VERSION}-linux-amd64.tar.gz`

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

test('resolveTargets parses an explicit instance list without calling AWS', () => {
  assert.deepEqual(resolveTargets({ INSTANCE_IDS: 'i-1,i-2' }), ['i-1', 'i-2'])
  assert.deepEqual(resolveTargets({ INSTANCE_IDS: ' i-1 , , i-2 ' }), ['i-1', 'i-2'])
})

test('buildRemoteScript rejects a version with no publishable release', () => {
  // Delegated to the shared resolver, so an unreleasable target fails on the deployer
  // rather than 404-ing on the runner.
  assert.throws(() => buildRemoteScript('0.9.8-alpha'), /not a stable semantic version/)
})

test('buildRemoteScript points at the shared release URLs', () => {
  const script = buildRemoteScript(VERSION)
  assert.ok(script.includes(`/v${VERSION}/${TARBALL}"`), 'fetches the tarball')
  assert.ok(script.includes(`/v${VERSION}/${TARBALL}.sha256"`), 'fetches the checksum sidecar')
})

test('buildRemoteScript fails closed when the checksum is missing or mismatched', () => {
  const script = buildRemoteScript(VERSION)
  assert.ok(script.includes('FATAL: checksum manifest does not name'), 'absent sidecar is fatal')
  assert.ok(script.includes('FATAL: checksum mismatch'), 'mismatched digest is fatal')
  // Integrity must be settled before the running service is touched.
  assert.ok(
    script.indexOf('FATAL: checksum mismatch') < script.indexOf('systemctl stop'),
    'verification precedes stopping the unit',
  )
})

test('the checksum manifest must name the tarball literally, not by pattern', () => {
  const payload = buildRemoteScript(VERSION)
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
  const script = buildRemoteScript(VERSION)
  assert.ok(script.includes('still bootstrapping'))
  assert.ok(script.indexOf('still bootstrapping') < script.indexOf('CURRENT=$(probe_version'))
})

test('buildRemoteScript threads ALLOW_DOWNGRADE through to the host', () => {
  assert.ok(buildRemoteScript(VERSION).includes('ALLOW_DOWNGRADE=""'))
  assert.ok(buildRemoteScript(VERSION, { allowDowngrade: true }).includes('ALLOW_DOWNGRADE="1"'))
})

test('buildRemoteScript honours a non-default runner port', () => {
  assert.ok(buildRemoteScript(VERSION, { runnerPort: '3100' }).includes('http://127.0.0.1:3100/'))
})

test('the payload never asks the binary for its version', () => {
  // The Go runner parses no CLI args, so `boxlite-runner --version` starts a second
  // process that exits non-zero — which is what made the old script report a failed
  // SSM run after a successful upgrade. The health route is the only version oracle.
  const script = buildRemoteScript(VERSION)
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

test('sendCommand retries only while the SSM agent is unregistered', () => {
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

const bash = (script, args = []) => spawnSync('bash', ['-c', script, 'test', ...args], { encoding: 'utf8' })

test('the generated payload is valid bash', () => {
  const check = spawnSync('bash', ['-n'], { input: buildRemoteScript(VERSION), encoding: 'utf8' })
  assert.equal(check.status, 0, check.stderr)
})

test('live_is_newer orders releases and prereleases the way semver does', () => {
  // Runs the comparison the production payload actually carries, rather than a copy.
  const payload = buildRemoteScript(VERSION)
  const fn = payload.slice(
    payload.indexOf('live_is_newer() {'),
    payload.indexOf('\n}\n', payload.indexOf('live_is_newer() {')) + 2,
  )

  const cases = [
    ['0.9.8-alpha', '0.9.7', true], // a prerelease still outranks an older release
    ['0.9.7', '0.9.8-alpha', false],
    ['0.9.8-alpha', '0.9.8', false], // prerelease precedes its own release: upgrade it
    ['0.9.10', '0.9.9', true], // numeric, not lexical
    ['1.0.0', '0.9.99', true],
    ['', '0.9.7', false], // an unreachable probe is never "newer"
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
