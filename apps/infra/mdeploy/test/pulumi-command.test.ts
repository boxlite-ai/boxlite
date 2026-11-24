import assert from 'node:assert/strict'
import test from 'node:test'
import { LocalWorkspace, PulumiCommand, type Stack } from '@pulumi/pulumi/automation/index.js'
import { createStack } from '../src/pulumi.ts'

test('AWS checks the operation deadline at CLI dispatch', async (t) => {
  const sent: AbortSignal[] = []
  const cli = {
    command: 'pulumi',
    run: async (
      _args: string[],
      _cwd: string,
      _env: object,
      _stdout: unknown,
      _stderr: unknown,
      signal: AbortSignal,
    ) => {
      sent.push(signal)
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  t.mock.method(PulumiCommand, 'get', async () => cli)
  const active = new AbortController().signal
  const expired = AbortSignal.abort(new Error('expired during workspace preparation'))
  t.mock.method(
    LocalWorkspace,
    'createOrSelectStack',
    async (_stack: unknown, options: Parameters<typeof LocalWorkspace.create>[0]) => {
      const workspace = await LocalWorkspace.create(options)
      // run is the SDK's internal dispatch boundary. Its public type omits this method.
      const command = workspace.pulumiCommand as unknown as typeof cli
      await command.run(['up'], workspace.workDir, {}, undefined, undefined, active)
      await assert.rejects(
        async () => command.run(['up'], workspace.workDir, {}, undefined, undefined, expired),
        /expired during workspace preparation/,
      )
      return {} as Stack
    },
  )
  await createStack({
    projectName: 'fixture',
    stackName: 'dev',
    backendUrl: 's3://fixture',
    envVars: {},
    program: async () => ({}),
  })
  assert.deepEqual(sent, [active])
})
