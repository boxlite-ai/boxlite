import assert from 'node:assert/strict'
import test from 'node:test'
import { upgradeRunner, type CommandResult } from '../src/upgrade-runners.ts'

const ok = (stdout = ''): CommandResult => ({ ok: true, status: 0, stdout, stderr: '' })

test('an interrupted supervision resumes the accepted command instead of submitting another mutation', () => {
  const environment = {
    RUNNER_UPGRADE_CLOUD: 'aws',
    RUNNER_UPGRADE_TARGET: 'i-0123456789abcdef0',
    RUNNER_UPGRADE_IDENTITY: '0.11.0',
    RUNNER_UPGRADE_PAYLOAD: Buffer.from('echo ready').toString('base64'),
    AWS_REGION: 'us-east-1',
  }
  let interrupted = true,
    submissions = 0,
    comment = ''
  const run = (_file: string, args: string[]) => {
    if (args[1] === 'list-commands')
      return ok(
        JSON.stringify({
          Commands: interrupted
            ? []
            : [
                {
                  InstanceIds: [environment.RUNNER_UPGRADE_TARGET],
                  CommandId: '00000000-0000-4000-a000-000000000002',
                  Comment: comment,
                  Status: 'InProgress',
                  DocumentName: 'AWS-RunShellScript',
                },
              ],
        }),
      )
    if (args[1] === 'send-command') {
      submissions++
      comment = args[args.indexOf('--comment') + 1]
      return ok('00000000-0000-4000-a000-000000000002')
    }
    if (args[1] === 'get-command-invocation') {
      return ok(args.includes('Status') ? (interrupted ? 'InProgress' : 'Success') : '')
    }
    assert.fail('unexpected command: ' + args.join(' '))
  }
  assert.throws(() => upgradeRunner({ environment, run, sleep: () => {}, log: () => {} }), /was still not terminal/)
  interrupted = false
  assert.equal(upgradeRunner({ environment, run, sleep: () => {}, log: () => {} }), 0)
  assert.equal(submissions, 1, 'retry duplicated an accepted, still-running remote mutation')
})

test('SSM refuses an unavailable or incomplete inventory before any new command', () => {
  for (const inventory of [
    { ok: false, status: 1, stdout: '', stderr: 'AccessDeniedException' },
    ok('{}'),
    ok(JSON.stringify({ Commands: [], NextToken: 'unread-page' })),
  ]) {
    let sent = 0
    assert.throws(
      () =>
        upgradeRunner({
          environment: {
            RUNNER_UPGRADE_CLOUD: 'aws',
            RUNNER_UPGRADE_TARGET: 'i-0123456789abcdef0',
            RUNNER_UPGRADE_IDENTITY: '0.11.0',
            RUNNER_UPGRADE_PAYLOAD: Buffer.from('echo ready').toString('base64'),
            AWS_REGION: 'us-east-1',
          },
          run: (_file, args) => {
            if (args[1] === 'send-command') sent++
            return inventory
          },
          sleep: () => {},
          log: () => {},
        }),
      /SSM command/,
    )
    assert.equal(sent, 0)
  }
})

test('SSM settles a different payload and requires another invocation before replacing it', () => {
  const calls: string[][] = []
  assert.throws(
    () =>
      upgradeRunner({
        environment: {
          RUNNER_UPGRADE_CLOUD: 'aws',
          RUNNER_UPGRADE_TARGET: 'i-0123456789abcdef0',
          RUNNER_UPGRADE_IDENTITY: '0.11.0',
          RUNNER_UPGRADE_PAYLOAD: Buffer.from('echo ready').toString('base64'),
          AWS_REGION: 'us-east-1',
        },
        run: (_file, args) => {
          calls.push(args)
          if (args[1] === 'list-commands')
            return ok(
              JSON.stringify({
                Commands: [
                  {
                    CommandId: '00000000-0000-4000-a000-000000000003',
                    Comment: 'boxlite-runner upgrade to 0.10.0',
                    InstanceIds: ['i-0123456789abcdef0'],
                  },
                ],
              }),
            )
          return ok(args.includes('Status') ? 'Success' : '')
        },
        sleep: () => {},
        log: () => {},
      }),
    /previous payload 00000000-0000-4000-a000-000000000003 settled Success/,
  )
  assert.equal(
    calls.some((args) => args[1] === 'send-command'),
    false,
  )
  assert.equal(
    calls.some((args) => args.includes('00000000-0000-4000-a000-000000000003') && args.includes('Status')),
    true,
  )
})

test('SSM retains every command ID when multiple previous updates overlap', () => {
  let sent = 0
  assert.throws(
    () =>
      upgradeRunner({
        environment: {
          RUNNER_UPGRADE_CLOUD: 'aws',
          RUNNER_UPGRADE_TARGET: 'i-0123456789abcdef0',
          RUNNER_UPGRADE_IDENTITY: '0.11.0',
          RUNNER_UPGRADE_PAYLOAD: 'ZWNobyByZWFkeQ==',
          AWS_REGION: 'us-east-1',
        },
        run: (_file, args) => {
          if (args[1] === 'send-command') sent++
          return ok(
            JSON.stringify({
              Commands: ['00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000002'].map(
                (CommandId) => ({
                  CommandId,
                  Comment: 'boxlite-runner upgrade to 0.10.0',
                  InstanceIds: ['i-0123456789abcdef0'],
                }),
              ),
            }),
          )
        },
        sleep: () => {},
        log: () => {},
      }),
    /reconcile commands 00000000-0000-4000-a000-000000000001, 00000000-0000-4000-a000-000000000002/,
  )
  assert.equal(sent, 0)
})

test("SSM bounds remote execution and ignores another host's active command", () => {
  const calls: string[][] = []
  assert.equal(
    upgradeRunner({
      environment: {
        RUNNER_UPGRADE_CLOUD: 'aws',
        RUNNER_UPGRADE_TARGET: 'i-0123456789abcdef0',
        RUNNER_UPGRADE_IDENTITY: '0.11.0',
        RUNNER_UPGRADE_PAYLOAD: 'ZWNobyByZWFkeQ==',
        AWS_REGION: 'us-east-1',
      },
      run: (_file, args) => {
        calls.push(args)
        if (args[1] === 'list-commands')
          return ok(
            JSON.stringify({
              Commands: [
                {
                  CommandId: '00000000-0000-4000-a000-000000000005',
                  Comment: 'boxlite-runner upgrade to 0.11.0',
                  InstanceIds: ['i-11111111111111111'],
                },
                { CommandId: 'unrelated-command', Targets: [{ Key: 'tag:Maintenance', Values: ['yes'] }] },
              ],
            }),
          )
        if (args[1] === 'send-command') return ok('00000000-0000-4000-a000-000000000004')
        return ok(args.includes('Status') ? 'Success' : '')
      },
      sleep: () => {},
      log: () => {},
    }),
    0,
  )
  const sent = calls.find((args) => args[1] === 'send-command')!
  assert.match(sent[sent.indexOf('--parameters') + 1], /executionTimeout=\["1800"\]/)
  assert.equal(sent[sent.indexOf('--timeout-seconds') + 1], '60')
  assert.ok(sent[sent.indexOf('--comment') + 1].length <= 100)
})
