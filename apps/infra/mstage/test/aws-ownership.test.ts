import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { awsOwnership, assertLegacyRoleFenced } from '../src/environment/aws-ownership.ts'

const scope = { app: 'boxlite-app', stage: 'dev' }
const legacyBytes = '{"checkpoint":{"latest":{"resources":[]}}}'
const frozen = { boxlite: createHash('sha256').update(legacyBytes).digest('hex') }
const fixture = () => {
  let clock = 1_000,
    revision = 0
  const objects = new Map<string, { body: string; etag: string }>()
  const calls: { command: string; input: any }[] = []
  let fence: any = { Version: '2012-10-17', Statement: [{ Effect: 'Deny', Action: '*', Resource: '*' }] }
  const iam = {
    send: async (command: any) => {
      calls.push({ command: command.constructor.name, input: command.input })
      return command.constructor.name === 'GetRoleCommand'
        ? { Role: {} }
        : { PolicyDocument: encodeURIComponent(JSON.stringify(fence)) }
    },
  }
  const s3 = {
    send: async (command: any) => {
      const { Key, Body, IfMatch, IfNoneMatch } = command.input
      calls.push({ command: command.constructor.name, input: command.input })
      const current = objects.get(Key)
      if (command.constructor.name === 'GetObjectCommand') {
        if (!current) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' })
        return { ETag: current.etag, Body: { transformToString: async () => current.body } }
      }
      if ((IfNoneMatch === '*' && current) || (IfMatch && current?.etag !== IfMatch)) {
        throw Object.assign(new Error('condition failed'), { name: 'PreconditionFailed' })
      }
      if (command.constructor.name === 'DeleteObjectCommand') {
        objects.delete(Key)
        return {}
      }
      const ETag = '"' + ++revision + '"'
      objects.set(Key, { body: String(Body), etag: ETag })
      return { ETag }
    },
  }
  const owner = awsOwnership({ s3, iam, stateBucket: async () => 'existing-state', now: () => clock })
  const recover = async () => {
    clock += 160_000
    await owner.transition({ ...scope, action: 'unlock', confirmed: true })
  }
  return {
    owner,
    objects,
    calls,
    recover,
    iam,
    setFence: (value: any) => {
      fence = value
    },
  }
}

test('a fresh native update persists ownership before submitting cloud work', async () => {
  const f = fixture()
  await f.owner.run({ ...scope, action: 'native' }, async ({ markNativeUpdateStarted }) => {
    assert.equal((await f.owner.inspect(scope))?.nativeUpdateStarted, false)
    await markNativeUpdateStarted()
    assert.equal((await f.owner.inspect(scope))?.nativeUpdateStarted, true)
  })
  assert.equal(f.objects.has('migration/aws/dev/lease.json'), false)
  const writes = f.calls.filter((call) => call.command === 'PutObjectCommand')
  assert.equal(writes[0].input.IfNoneMatch, '*')
  assert.equal(writes[1].input.IfNoneMatch, '*')
  assert.ok(writes[2].input.IfMatch)
  assert.ok(f.calls.find((call) => call.command === 'DeleteObjectCommand')!.input.IfMatch)
})

test('adoption blocks both deployers and permits migration work until explicit cutover', async () => {
  const f = fixture()
  f.objects.set('app/boxlite/dev.json', { etag: 'legacy', body: legacyBytes })
  await f.owner.transition({ ...scope, action: 'begin', sourceDigests: frozen, confirmed: true })
  for (const action of ['native', 'legacy'] as const) {
    await assert.rejects(
      f.owner.run({ ...scope, action }, async () => assert.fail('mutation ran')),
      /blocked|explicit native cutover/,
    )
    await f.recover()
  }
  await f.owner.run({ ...scope, action: 'migration' }, async () => {})
  await f.owner.transition({ ...scope, action: 'cutover', confirmed: true })
  assert.equal((await f.owner.inspect(scope))?.phase, 'native')
  await assert.rejects(
    f.owner.run({ ...scope, action: 'legacy' }, async () => assert.fail('legacy mutation ran')),
    /Legacy deployment is blocked/,
  )
})

test('an uncertain native update permanently closes the legacy rollback path', async () => {
  const f = fixture()
  f.objects.set('app/boxlite/dev.json', { etag: 'legacy', body: legacyBytes })
  await f.owner.transition({ ...scope, action: 'begin', sourceDigests: frozen, confirmed: true })
  await f.owner.transition({ ...scope, action: 'cutover', confirmed: true })
  await assert.rejects(
    f.owner.run({ ...scope, action: 'native' }, async ({ markNativeUpdateStarted }) => {
      await markNativeUpdateStarted()
      throw new Error('response lost after submission')
    }),
    /response lost/,
  )
  assert.equal((await f.owner.inspect(scope))?.nativeUpdateStarted, true)
  assert.equal(f.objects.has('migration/aws/dev/lease.json'), true)
  await assert.rejects(f.owner.transition({ ...scope, action: 'unlock', confirmed: true }), /has not expired/)
  await f.recover()
  await assert.rejects(f.owner.transition({ ...scope, action: 'rollback', confirmed: true }), /forward repair/)
})

test('pre-update rollback preserves frozen evidence and blocks the native deployer', async () => {
  const f = fixture()
  f.objects.set('app/boxlite/dev.json', { etag: 'legacy', body: legacyBytes })
  await f.owner.transition({ ...scope, action: 'begin', sourceDigests: frozen, confirmed: true })
  await f.owner.transition({ ...scope, action: 'rollback', confirmed: true })
  assert.deepEqual((await f.owner.inspect(scope))?.sourceDigests, frozen)
  await f.owner.run({ ...scope, app: 'boxlite', action: 'legacy' }, async () => {})
  await assert.rejects(
    f.owner.run({ ...scope, action: 'native' }, async () => assert.fail()),
    /explicit native cutover/,
  )
})

test('conditional leases exclude a concurrent process, including another app in the same stage', async () => {
  const f = fixture()
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const first = f.owner.run({ ...scope, action: 'native' }, async () => {
    entered()
    await barrier
  })
  await ready
  await assert.rejects(
    f.owner.run({ ...scope, app: 'another-app', action: 'native' }, async () => assert.fail()),
    /already has an ownership lease/,
  )
  release()
  await first
})

test('the historical deploy role must have an unconditional IAM deny before native access', async () => {
  const f = fixture()
  for (const policy of [
    { Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] },
    { Statement: [{ Effect: 'Deny', Action: '*', Resource: '*', Condition: {} }] },
    { Statement: [{ Effect: 'Deny', Action: ['ec2:*'], Resource: '*' }] },
  ]) {
    f.setFence(policy)
    await assert.rejects(assertLegacyRoleFenced(f.iam, 'dev'), /deny all actions/)
  }
  f.setFence({ Statement: [{ Effect: 'Deny', Action: ['*'], Resource: ['*'] }] })
  await assertLegacyRoleFenced(f.iam, 'dev')
  assert.ok(
    f.calls.some(
      (call) =>
        call.input.RoleName === 'boxlite-dev-github-deploy' && call.input.PolicyName === 'BoxLiteLegacyDeploymentFence',
    ),
  )
  await assert.rejects(
    assertLegacyRoleFenced(
      {
        send: async () => {
          throw new Error('AccessDenied')
        },
      },
      'dev',
    ),
    /AccessDenied/,
  )
})

test('ownership validates names, records and confirmation before mutation', async () => {
  const f = fixture()
  await assert.rejects(f.owner.inspect({ ...scope, stage: '../prod' }), /safe app and stage/)
  await assert.rejects(f.owner.transition({ ...scope, action: 'begin', confirmed: false }), /--confirm/)
  assert.equal(f.calls.length, 0)
  f.objects.set('migration/aws/dev/owner.json', { etag: '"manual"', body: '{"version":9}' })
  await assert.rejects(f.owner.inspect(scope), /record is invalid/)
})

test('existing SST state cannot be claimed by an ordinary native deployment', async () => {
  const f = fixture()
  f.objects.set('app/boxlite/dev.json', { etag: 'legacy', body: legacyBytes })
  await assert.rejects(
    f.owner.run({ ...scope, action: 'native' }, async () => assert.fail('native mutation ran')),
    /explicit adoption and native cutover/,
  )
  assert.equal(await f.owner.inspect(scope), null)
})

test('changed frozen state cannot be acknowledged away after cutover', async () => {
  const f = fixture()
  f.objects.set('app/boxlite/dev.json', { etag: 'legacy', body: legacyBytes })
  await f.owner.transition({ ...scope, action: 'begin', sourceDigests: frozen, confirmed: true })
  await f.owner.transition({ ...scope, action: 'cutover', confirmed: true })
  f.objects.set('app/boxlite/dev.json', { etag: 'changed', body: legacyBytes + ' ' })
  await assert.rejects(
    f.owner.run({ ...scope, action: 'native' }, async () => assert.fail('native mutation ran')),
    /Frozen legacy checkpoints changed/,
  )
})

test('a lost lease prevents cutover after a long validation completes', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture()
  f.objects.set('app/boxlite/dev.json', { etag: 'legacy', body: legacyBytes })
  await f.owner.transition({ ...scope, action: 'begin', sourceDigests: frozen, confirmed: true })
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const transitioning = f.owner.transition({
    ...scope,
    action: 'cutover',
    confirmed: true,
    validate: async () => {
      entered()
      await barrier
    },
  })
  const rejected = assert.rejects(transitioning, /condition failed/)
  await ready
  const lease = f.objects.get('migration/aws/dev/lease.json')!
  f.objects.set('migration/aws/dev/lease.json', { ...lease, etag: 'another-owner' })
  t.mock.timers.tick(30_000)
  await new Promise<void>((resolve) => setImmediate(resolve))
  release()
  await rejected
  assert.equal((await f.owner.inspect(scope))?.phase, 'adopting')
})
