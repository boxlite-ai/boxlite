import assert from 'node:assert/strict'
import test from 'node:test'
import { bootstrapAwsState } from './aws-state.js'
import { readEnvironment, setValues, writeStage, type Clients } from 'mstage/env'

test('native bootstrap preserves encryption keys and config across repeated initialization', async () => {
  const parameters = new Map<string, string>()
  const objects = new Map<string, Buffer>()
  const buckets = new Set<string>()
  const calls: { name: string; input: any }[] = []
  const clients: Clients = {
    ssm: {
      send: async (command: any) => {
        calls.push({ name: command.constructor.name, input: command.input })
        const { Name, Value, Overwrite } = command.input
        if (command.constructor.name === 'GetParameterCommand') {
          if (!parameters.has(Name)) throw Object.assign(new Error('missing'), { name: 'ParameterNotFound' })
          return { Parameter: { Value: parameters.get(Name) } }
        }
        assert.equal(Overwrite, false, 'an encryption key must never be rotated implicitly')
        assert.equal(parameters.has(Name), false)
        parameters.set(Name, Value)
        return {}
      },
    },
    s3: {
      send: async (command: any) => {
        calls.push({ name: command.constructor.name, input: command.input })
        const { Bucket, Key, Body } = command.input
        switch (command.constructor.name) {
          case 'HeadBucketCommand':
            if (!buckets.has(Bucket)) throw Object.assign(new Error('missing'), { name: 'NotFound' })
            return {}
          case 'CreateBucketCommand':
            buckets.add(Bucket)
            return {}
          case 'GetObjectCommand': {
            const bytes = objects.get(Key)
            if (!bytes) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' })
            return { ETag: '"current"', Body: { transformToByteArray: async () => bytes } }
          }
          case 'PutObjectCommand':
            objects.set(Key, Buffer.from(Body))
            return {}
          default:
            return {}
        }
      },
    },
  }
  const input = { clients, app: 'community-app', stage: 'dev', accountId: '123456789012', region: 'us-east-1' }
  const bucket = await bootstrapAwsState(input)
  const first = await readEnvironment({ clients, app: input.app, stage: input.stage })
  assert.equal(bucket, 'boxlite-state-us-east-1-123456789012')
  assert.ok(first.PULUMI_CONFIG_PASSPHRASE)
  await setValues({ clients, app: input.app, stage: input.stage, entries: [['STACK_DOMAIN', 'example.test']] })
  await bootstrapAwsState(input)
  const after = await readEnvironment({ clients, app: input.app, stage: input.stage })
  assert.equal(after.PULUMI_CONFIG_PASSPHRASE, first.PULUMI_CONFIG_PASSPHRASE)
  assert.equal(after.STACK_DOMAIN, 'example.test')
  assert.equal(
    calls.filter((call) => call.name === 'PutBucketEncryptionCommand').length,
    1,
    're-bootstrap must preserve existing encryption',
  )
  assert.equal(calls.filter((call) => call.name === 'PutParameterCommand').length, 2)
  assert.ok(calls.some((call) => call.name === 'PutPublicAccessBlockCommand'))
  assert.ok(calls.some((call) => call.name === 'PutBucketVersioningCommand'))
})

test('native state bootstrap refuses access errors and invalid names before provisioning', async () => {
  let writes = 0
  const clients = {
    s3: {
      send: async () => {
        writes++
        return {}
      },
    },
    ssm: {
      send: async () => {
        throw new Error('AccessDenied')
      },
    },
  } as Clients
  const input = { clients, app: 'boxlite-app', stage: 'dev', accountId: '123456789012', region: 'us-east-1' }
  await assert.rejects(bootstrapAwsState(input), /AccessDenied/)
  await assert.rejects(bootstrapAwsState({ ...input, app: '../other' }), /Invalid AWS bootstrap/)
  assert.equal(writes, 0)
})

for (const competing of ['bootstrap', 'environment edit'] as const) {
  test(`bootstrap preserves the winning revision during a concurrent ${competing}`, async () => {
    let release!: () => void
    const bothRead = new Promise<void>((done) => {
      release = done
    })
    let reads = 0
    let revision = 0
    let stored: Buffer | undefined
    const clients: Clients = {
      ssm: {
        send: async ({ input }) => ({
          Parameter: {
            Value:
              input.Name === '/sst/bootstrap'
                ? JSON.stringify({ state: 'existing-state' })
                : Buffer.alloc(32, 1).toString('base64'),
          },
        }),
      },
      s3: {
        send: async (command) => {
          if (command.constructor.name === 'GetObjectCommand') {
            const bytes = stored
            const ETag = '"' + revision + '"'
            if (++reads === 2) release()
            await bothRead
            if (!bytes) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' })
            return { ETag, Body: { transformToByteArray: async () => bytes } }
          }
          if (command.constructor.name === 'PutObjectCommand') {
            if (
              (stored && command.input.IfNoneMatch === '*') ||
              (command.input.IfMatch && command.input.IfMatch !== '"' + revision + '"')
            )
              throw Object.assign(new Error('concurrent writer'), { name: 'PreconditionFailed' })
            stored = Buffer.from(command.input.Body)
            revision++
          }
          return {}
        },
      },
    }
    const input = { clients, app: 'community', stage: 'dev', accountId: '123456789012', region: 'us-east-1' }
    if (competing === 'environment edit') await writeStage({ ...input, values: { EXISTING: 'original' } })
    await Promise.all([
      bootstrapAwsState(input),
      competing === 'bootstrap'
        ? bootstrapAwsState(input)
        : setValues({ ...input, entries: [['DOMAIN', 'example.test']] }),
    ])
    const result = await readEnvironment(input)
    assert.ok(result.PULUMI_CONFIG_PASSPHRASE)
    if (competing === 'bootstrap') assert.equal(revision, 1)
    else assert.deepEqual([result.EXISTING, result.DOMAIN], ['original', 'example.test'])
  })
}
