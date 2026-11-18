import assert from 'node:assert/strict'
import test from 'node:test'
import { bootstrapAwsState } from './aws-state.js'
import { readEnvironment, setValues, type Clients } from 'mstage/env'

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
            return { Body: { transformToByteArray: async () => bytes } }
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
