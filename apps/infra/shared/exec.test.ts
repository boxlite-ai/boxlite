// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { remainingTimeoutMs, runAwsJson, runAwsText, signalProcessGroup } from './exec.js'

function withStubbedAwsCli(script: string, run: (awsCliPath: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'boxlite-infra-aws-cli-'))
  const awsCliPath = join(directory, 'aws-cli')
  const previousAwsCliPath = process.env.AWS_CLI_PATH
  const previousPath = process.env.PATH

  writeFileSync(awsCliPath, script)
  chmodSync(awsCliPath, 0o755)
  process.env.AWS_CLI_PATH = awsCliPath
  // Emptied so a real `aws` on PATH cannot answer instead of the stub.
  process.env.PATH = directory

  try {
    run(awsCliPath)
  } finally {
    if (previousAwsCliPath === undefined) delete process.env.AWS_CLI_PATH
    else process.env.AWS_CLI_PATH = previousAwsCliPath
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    rmSync(directory, { recursive: true, force: true })
  }
}

test('runs the configured AWS CLI when PATH does not contain aws', () => {
  withStubbedAwsCli('#!/bin/sh\nprintf \'%s\\n\' \'{"Account":"123456789012"}\'\n', () => {
    assert.deepEqual(runAwsJson(['sts', 'get-caller-identity'], { region: 'ap-southeast-1' }), {
      Account: '123456789012',
    })
  })
})

test('passes the region, the output format and a disabled pager to every call', () => {
  // A pager attached to a captured stdout never returns, so --no-cli-pager is not optional.
  withStubbedAwsCli('#!/bin/sh\nprintf \'%s\\n\' "$*"\n', () => {
    assert.equal(
      runAwsText(['ssm', 'get-parameter', '--name', '/boxlite/dev/token'], { region: 'ap-southeast-1' }),
      'ssm get-parameter --name /boxlite/dev/token --region ap-southeast-1 --output text --no-cli-pager',
    )
  })
})

test('reports which AWS call failed rather than the raw exit status', () => {
  withStubbedAwsCli('#!/bin/sh\necho "AccessDenied" >&2\nexit 254\n', () => {
    assert.throws(() => runAwsJson(['iam', 'get-role'], { region: 'ap-southeast-1' }), {
      message: /AWS iam get-role failed: AccessDenied/,
    })
  })
})

test('refuses output that is not the JSON it asked for', () => {
  withStubbedAwsCli('#!/bin/sh\nprintf \'%s\\n\' \'<html>proxy error</html>\'\n', () => {
    assert.throws(() => runAwsJson(['ecs', 'describe-services'], { region: 'ap-southeast-1' }), {
      message: /AWS ecs describe-services returned invalid JSON/,
    })
  })
})

test('a missing AWS CLI stays an ENOENT so callers can degrade instead of failing', () => {
  // deployment/sst.ts skips its SSM lookup on this code; a wrapped error would hide it.
  const previousAwsCliPath = process.env.AWS_CLI_PATH
  process.env.AWS_CLI_PATH = join(tmpdir(), 'boxlite-infra-absent-aws-cli')
  try {
    assert.throws(() => runAwsText(['ssm', 'get-parameter'], { region: 'ap-southeast-1' }), { code: 'ENOENT' })
  } finally {
    if (previousAwsCliPath === undefined) delete process.env.AWS_CLI_PATH
    else process.env.AWS_CLI_PATH = previousAwsCliPath
  }
})

test('spends one deadline across a multi-call preflight', () => {
  assert.ok(remainingTimeoutMs(Date.now() + 5_000, 'Runner artifact preflight') <= 5_000)
  assert.throws(() => remainingTimeoutMs(Date.now() - 1, 'Runner artifact preflight'), {
    message: 'Runner artifact preflight exceeded its timeout',
  })
})

test('falls back to the direct child only while it is still running', () => {
  // A child that never spawned has no pid, so there is no group to address and the fallback is the
  // only path left — which is where the already-exited guard has to hold. Fabricated pids are
  // deliberately not used here: signalProcessGroup would reach the real process.kill(-pid) and
  // signal whatever unrelated group happens to own that number on this host.
  const signals: any[] = []
  const exited = { pid: undefined, exitCode: 0, signalCode: null, kill: (signal: any) => signals.push(signal) }
  const running = { pid: undefined, exitCode: null, signalCode: null, kill: (signal: any) => signals.push(signal) }

  signalProcessGroup(exited, 'SIGINT')
  signalProcessGroup(running, 'SIGINT')
  assert.deepEqual(signals, ['SIGINT'])
})

test('signals the whole group of a detached child, not just the child', async () => {
  // The reason this helper exists: sst and curl spawn children of their own, and killing only the
  // direct child strands them holding the deploy open. Asserted on a grandchild, because a lone
  // child dies either way and would not tell the two apart. Uses a group this test owns rather
  // than a guessed pid, which would signal whatever unrelated group holds that number.
  const parent = spawn(
    process.execPath,
    [
      '-e',
      "const { spawn } = require('node:child_process');" +
        "const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });" +
        'console.log(grandchild.pid);' +
        'setTimeout(() => {}, 60_000)',
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
  )
  const [announced] = await once(parent.stdout, 'data')
  const grandchildPid = Number(String(announced).trim())
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, 'the child did not report a grandchild')

  const exit: Promise<any> = once(parent, 'exit')
  signalProcessGroup(parent, 'SIGKILL')
  const [code, signal] = await exit
  assert.equal(code, null)
  assert.equal(signal, 'SIGKILL')

  // The grandchild is reaped by init asynchronously, so poll rather than read once.
  const deadline = Date.now() + 5_000
  let grandchildAlive = true
  while (grandchildAlive && Date.now() < deadline) {
    try {
      process.kill(grandchildPid, 0)
      await new Promise((resolve) => setTimeout(resolve, 25))
    } catch {
      grandchildAlive = false
    }
  }
  assert.equal(grandchildAlive, false, 'the grandchild outlived the group signal')
})
