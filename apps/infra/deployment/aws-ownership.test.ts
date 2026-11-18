import assert from 'node:assert/strict'
import test from 'node:test'
import { SSMClient } from '@aws-sdk/client-ssm'
import { S3Client } from '@aws-sdk/client-s3'
import { assertLegacyDeploymentAllowed, withLegacyDeploymentOwnership } from './aws-ownership.ts'

const scope = { stage: 'QA', region: 'us-east-1' }

test('direct SST checks distinguish a first install from an unreadable bootstrap', async (t) => {
  const lookup = t.mock.method(SSMClient.prototype, 'send', async () => {
    throw Object.assign(new Error(), { name: 'ParameterNotFound' })
  })
  await assertLegacyDeploymentAllowed(scope)
  lookup.mock.mockImplementation(async () => {
    throw new Error('AccessDenied')
  })
  await assert.rejects(assertLegacyDeploymentAllowed(scope), /AccessDenied/)
})

test('a direct SST invocation observes the stored ownership phase in the exact stage', async (t) => {
  let phase = 'legacy'
  t.mock.method(SSMClient.prototype, 'send', async (command: any) => {
    assert.equal(command.input.Name, '/sst/bootstrap')
    return { Parameter: { Value: JSON.stringify({ state: 'state-bucket' }) } }
  })
  t.mock.method(S3Client.prototype, 'send', async (command: any) => {
    assert.equal(command.constructor.name, 'GetObjectCommand')
    assert.deepEqual(command.input, { Bucket: 'state-bucket', Key: 'migration/aws/QA/owner.json' })
    const value = { version: 1, app: 'boxlite', phase, nativeUpdateStarted: false, sourceDigests: {} }
    return { ETag: '"owner"', Body: { transformToString: async () => JSON.stringify(value) } }
  })
  await assertLegacyDeploymentAllowed(scope)
  for (phase of ['adopting', 'native']) {
    await assert.rejects(assertLegacyDeploymentAllowed(scope), new RegExp('blocked while AWS ownership is ' + phase))
  }
})

test('the legacy wrapper never starts work when another deployment holds the lease', async (t) => {
  t.mock.method(SSMClient.prototype, 'send', async () => ({ Parameter: { Value: '{"state":"state-bucket"}' } }))
  const writes: Array<{ command: string; key: string; condition: string }> = []
  t.mock.method(S3Client.prototype, 'send', async (command: any) => {
    writes.push({ command: command.constructor.name, key: command.input.Key, condition: command.input.IfNoneMatch })
    throw Object.assign(new Error('lease occupied'), { name: 'PreconditionFailed' })
  })
  let invoked = false
  await assert.rejects(
    withLegacyDeploymentOwnership(scope, async () => {
      invoked = true
    }),
    /^Error: AWS stage QA already has an ownership lease;/,
  )
  assert.deepEqual(writes, [{ command: 'PutObjectCommand', key: 'migration/aws/QA/lease.json', condition: '*' }])
  assert.equal(invoked, false)
})
