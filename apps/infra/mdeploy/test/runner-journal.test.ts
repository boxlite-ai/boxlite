import assert from 'node:assert/strict'
import { objectStore } from './runner-journal-fixture.ts'
import test from 'node:test'
import { upgradeRunner, type CommandResult, type RunCommand } from '../src/upgrade-runners.ts'
import { updateRunners } from '../src/runner-update.ts'

const ok = (stdout = ''): CommandResult => ({ ok: true, status: 0, stdout, stderr: '' })
const fail = (stderr: string): CommandResult => ({ ok: false, status: 1, stdout: '', stderr })
const host = 'i-0123456789abcdef0'
const replacement = 'i-0123456789abcdef1'

const fixture = (firstError: string | CommandResult = 'connection closed after acceptance') => {
  const store = objectStore()
  const sent: { CommandId: string; Comment: string; InstanceIds: string[] }[] = []
  let visible = false
  let onPut: (() => void) | undefined
  let onPoll: (() => void) | undefined
  const run: RunCommand = (file, args) => {
    const arg = (flag: string) => args[args.indexOf(flag) + 1]!
    if (args[0] === 's3api') {
      if (args[1] === 'put-object') {
        const callback = onPut
        onPut = undefined
        callback?.()
      }
      return store.run(file, args)
    }
    if (args[0] === 'sts') return ok('arn:aws:iam::123456789012:user/operator')
    if (args[1] === 'list-commands')
      return ok(
        JSON.stringify({ Commands: visible && !args.includes('key=ExecutionStage,value=Executing') ? sent : [] }),
      )
    if (args[1] === 'send-command') {
      const CommandId = '00000000-0000-4000-a000-' + String(sent.length + 1).padStart(12, '0')
      sent.push({ CommandId, Comment: arg('--comment'), InstanceIds: [arg('--instance-ids')] })
      if (sent.length === 1) return typeof firstError === 'string' ? fail(firstError) : firstError
      return ok(CommandId)
    }
    if (args[1] === 'get-command-invocation') {
      const callback = onPoll
      onPoll = undefined
      callback?.()
      return ok(args.includes('Status') ? 'Success' : '')
    }
    assert.fail('unexpected command: ' + args.join(' '))
  }
  const roll = (instance = host, script = 'echo v1', identity = 'v1') =>
    upgradeRunner({
      environment: {
        RUNNER_UPGRADE_CLOUD: 'aws',
        AWS_REGION: 'ap-southeast-1',
        RUNNER_UPGRADE_TARGET: instance,
        RUNNER_UPGRADE_APP: 'boxlite-app',
        RUNNER_UPGRADE_STAGE: 'dev',
        RUNNER_UPGRADE_STATE_BUCKET: 'state-bucket',
        RUNNER_UPGRADE_IDENTITY: identity,
        RUNNER_UPGRADE_PAYLOAD: Buffer.from(script).toString('base64'),
      },
      run,
      sleep: () => {},
      log: () => {},
    })
  const inspect = (instance = host) => {
    const item = store.objects.get('rollouts/aws/boxlite-app/dev/ap-southeast-1/' + instance + '.json')
    return item && JSON.parse(item.body)
  }
  const operate = (args: string[], log = (_: string) => {}) =>
    updateRunners({
      argv: ['--stage', 'dev', '--host', host, ...args],
      environment: { MSTAGE_CONFIG: new URL('../../.mstage.config.example.json', import.meta.url).pathname },
      cwd: new URL('../..', import.meta.url).pathname,
      log,
      checkLogin: async () => 0,
      resolveHomeWith: (async () => ({
        stateBucket: async () => 'state-bucket',
        identity: { home: 'aws', childEnvironment: async () => ({ env: {} }) },
      })) as never,
      run,
      sleep: () => {},
    })
  return {
    roll,
    sent,
    inspect,
    operate,
    run,
    beforePut: (fn: () => void) => {
      onPut = fn
    },
    reveal: () => {
      visible = true
    },
    beforePoll: (fn: () => void) => {
      onPoll = fn
    },
    store,
  }
}

test('lost SSM response plus delayed visibility never resubmits the same mutation', () => {
  const f = fixture()
  assert.throws(() => f.roll(), /connection closed after acceptance/)
  try {
    f.roll()
  } catch {
    /* An invisible receipt keeps the reservation. */
  }
  assert.equal(f.sent.length, 1, 'retry sent the accepted command twice')
  assert.throws(() => f.roll(host, 'echo v2'), /operation/i)
  f.reveal()
  assert.equal(f.roll(), 0)
  assert.equal(f.sent.length, 1)
  assert.equal(f.inspect().status, 'succeeded')
})

test('replacement can proceed immediately and exact forced release permits reuse of the original host', async () => {
  const f = fixture()
  assert.throws(() => f.roll(), /connection closed/)
  assert.equal(f.roll(replacement), 0)
  const original = f.inspect()
  const lines: string[] = []
  await f.operate(['--rollout-status'], (line) => lines.push(line))
  assert.ok(lines.join(' ').includes(original.operationId))
  await assert.rejects(f.operate(['--force-unlock', original.operationId, '--reason', 'replace']), /confirm/)
  await assert.rejects(f.operate(['--force-unlock', original.operationId, '--confirm']), /reason/)
  await assert.rejects(f.operate(['--force-unlock', 'wrong', '--reason', 'replace', '--confirm']), /operation/i)
  assert.equal(f.inspect().status, 'submitting')
  await f.operate(['--force-unlock', original.operationId, '--reason', 'replace failed host', '--confirm'])
  assert.equal(f.inspect().status, 'superseded')
  assert.equal(f.inspect().reason, 'replace failed host')
  assert.match(f.inspect().actor, /operator$/)
  assert.equal(f.roll(host, 'echo v2'), 0)
  assert.notEqual(f.inspect().operationId, original.operationId)
  assert.deepEqual(
    f.sent.map((c) => c.InstanceIds[0]),
    [host, replacement, host],
  )
})

test('two deployers racing for an empty instance record send at most once', () => {
  const f = fixture()
  f.beforePut(() => assert.throws(() => f.roll(), /connection closed/))
  assert.throws(() => f.roll(), /PreconditionFailed/)
  assert.equal(f.sent.length, 1)
  assert.equal(f.inspect().status, 'submitting')
})

test('a previous supervisor cannot overwrite a replacement operation after force unlock', async () => {
  const { runnerJournal } = await import('../src/runner-journal.ts')
  const f = fixture()
  assert.throws(() => f.roll(), /connection closed/)
  const old = f.inspect().operationId
  f.reveal()
  f.beforePoll(() => {
    const journal = runnerJournal(
      { app: 'boxlite-app', stage: 'dev', bucket: 'state-bucket' },
      'ap-southeast-1',
      host,
      f.run,
    )
    const release = journal.release(old, 'replace now')
    assert.equal(release.entry.commandId, '00000000-0000-4000-a000-000000000001')
    assert.equal(f.roll(host, 'echo v2'), 0)
  })
  assert.throws(() => f.roll(), /PreconditionFailed/)
  assert.equal(f.inspect().status, 'succeeded')
  assert.equal(f.inspect().commandId, '00000000-0000-4000-a000-000000000002')
  assert.notEqual(f.inspect().operationId, old)
})

test('record access and integrity failures stop submission', async () => {
  const { runnerJournal } = await import('../src/runner-journal.ts')
  const f = fixture()
  assert.throws(() => f.roll(), /connection closed/)
  const [[key, stored]] = f.store.objects
  stored.body = '{}'
  assert.throws(() => f.roll(), /Invalid Runner operation/)
  assert.equal(f.sent.length, 1)
  const denied = runnerJournal(
    { app: 'boxlite-app', stage: 'dev', bucket: 'state-bucket' },
    'ap-southeast-1',
    host,
    () => fail('(AccessDenied)'),
  )
  assert.throws(() => denied.read(), /AccessDenied/)
  assert.match(key, /rollouts\/aws\/boxlite-app\/dev\/ap-southeast-1\/i-/)
  assert.throws(
    () =>
      runnerJournal({ app: 'boxlite-app', stage: '../prod', bucket: 'state-bucket' }, 'ap-southeast-1', host, f.run),
    /valid app/,
  )
})

test('an already completed different operation is settled before the requested payload is sent', () => {
  const f = fixture()
  assert.throws(() => f.roll(), /connection closed/)
  f.reveal()
  assert.throws(() => f.roll(host, 'echo v2'), /previous payload 00000000-0000-4000-a000-000000000001 settled Success/)
  assert.equal(f.sent.length, 1)
  assert.equal(f.roll(host, 'echo v2'), 0)
  assert.equal(f.sent.length, 2)
})

test('SSM comments retain operation identity within the 100-character limit for build versions', () => {
  const f = fixture()
  const version = '0.11.0+' + 'a'.repeat(40)
  assert.throws(() => f.roll(host, 'echo v1', version), /connection closed/)
  assert.ok(f.sent[0].Comment.length <= 100)
  assert.ok(f.sent[0].Comment.includes(f.inspect().operationId))
  assert.equal(f.inspect().identity, version)
})

test('two supervisors report the same successful terminal receipt without resubmitting', () => {
  const f = fixture()
  assert.throws(() => f.roll(), /connection closed/)
  f.reveal()
  f.beforePoll(() => assert.equal(f.roll(), 0))
  assert.equal(f.roll(), 0)
  assert.equal(f.sent.length, 1)
  assert.equal(f.inspect().status, 'succeeded')
})

test('explicit SSM authorization rejection permits normal retry after credentials are corrected', () => {
  const f = fixture('An error occurred (AccessDeniedException) when calling the SendCommand operation: unauthorized')
  assert.throws(() => f.roll(), /AccessDeniedException/)
  assert.equal(f.roll(), 0)
  assert.equal(f.inspect().status, 'succeeded')
})

test('a missing AWS CLI text result leaves the accepted operation recoverable by its comment', () => {
  const f = fixture(ok('None'))
  assert.throws(() => f.roll(), /without a valid command ID/)
  assert.equal(f.inspect().status, 'submitting')
  f.reveal()
  assert.equal(f.roll(), 0)
  assert.equal(f.sent.length, 1)
})

test('an existing mixed-case AWS app and stage address the same exact instance for update and recovery', async () => {
  const { runnerJournal } = await import('../src/runner-journal.ts')
  const f = fixture()
  const scope = { app: 'BoxLite', stage: 'QA', bucket: 'state-bucket' }
  assert.throws(
    () =>
      upgradeRunner({
        environment: {
          RUNNER_UPGRADE_APP: scope.app,
          RUNNER_UPGRADE_STAGE: scope.stage,
          RUNNER_UPGRADE_STATE_BUCKET: scope.bucket,
          RUNNER_UPGRADE_CLOUD: 'aws',
          RUNNER_UPGRADE_TARGET: host,
          AWS_REGION: 'ap-southeast-1',
          RUNNER_UPGRADE_IDENTITY: '0.11.0',
          RUNNER_UPGRADE_PAYLOAD: Buffer.from('echo QA').toString('base64'),
        },
        run: f.run,
        log: () => {},
        sleep: () => {},
      }),
    /connection closed after acceptance/,
  )
  const journal = runnerJournal(scope, 'ap-southeast-1', host, f.run)
  const id = journal.read()!.entry.operationId
  assert.equal(journal.release(id, 'isolate QA host').entry.status, 'superseded')
  assert.ok(f.store.objects.has('rollouts/aws/BoxLite/QA/ap-southeast-1/' + host + '.json'))
  assert.equal(runnerJournal({ ...scope, stage: 'qa' }, 'ap-southeast-1', host, f.run).read(), null)
})
