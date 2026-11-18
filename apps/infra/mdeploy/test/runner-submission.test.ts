import assert from 'node:assert/strict'
import test from 'node:test'
import { upgradeRunner, type CommandResult } from '../src/upgrade-runners.ts'

const ok = (stdout = ''): CommandResult => ({ ok: true, status: 0, stdout, stderr: '' })

test('an accepted SSM submission with a lost response is reconciled before retry', () => {
  const environment = {
    RUNNER_UPGRADE_CLOUD: 'aws',
    RUNNER_UPGRADE_TARGET: 'i-0123456789abcdef0',
    RUNNER_UPGRADE_IDENTITY: '0.11.0',
    RUNNER_UPGRADE_PAYLOAD: Buffer.from('echo ready').toString('base64'),
    AWS_REGION: 'us-east-1',
  }
  let submissions = 0
  let acceptedComment: string | undefined
  const run = (_file: string, args: string[]): CommandResult => {
    if (args[1] === 'list-commands')
      return ok(
        JSON.stringify({
          Commands: acceptedComment
            ? [
                {
                  CommandId: 'accepted-command',
                  Comment: acceptedComment,
                  InstanceIds: [environment.RUNNER_UPGRADE_TARGET],
                },
              ]
            : [],
        }),
      )
    if (args[1] === 'send-command') {
      submissions++
      acceptedComment = args[args.indexOf('--comment') + 1]
      return submissions === 1
        ? { ok: false, status: 124, stdout: '', stderr: 'response lost after acceptance' }
        : ok('duplicate-command')
    }
    if (args[1] === 'get-command-invocation') return ok(args.includes('Status') ? 'Success' : '')
    assert.fail('unexpected command: ' + args.join(' '))
  }
  assert.throws(
    () => upgradeRunner({ environment, run, sleep: () => {}, log: () => {} }),
    /response lost after acceptance/,
  )
  assert.equal(upgradeRunner({ environment, run, sleep: () => {}, log: () => {} }), 0)
  assert.equal(submissions, 1, 'retry submitted another mutation after losing an accepted response')
})
