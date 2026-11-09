import assert from 'node:assert/strict'
import test from 'node:test'
import { parseBuildConfig } from '../src/config.ts'
import { resolveRegistry } from '../src/address.ts'
import { promote, type Run } from '../src/publish.ts'

const SHA = 'a'.repeat(40)
const DIGEST = `sha256:${'b'.repeat(64)}`
const OTHER = `sha256:${'c'.repeat(64)}`
const config = parseBuildConfig({
  basePath: '/repo/mstage.env.json',
  base: JSON.stringify({ root: '.', artifacts: { api: { dockerfile: 'Dockerfile', context: '.' } } }),
  stagePath: '/repo/.mstage.config.json',
  stages: JSON.stringify({
    stages: Object.fromEntries(
      ['dev', 'stage', 'prod'].map((stage) => [
        stage,
        {
          home: 'gcp',
          project: 'boxlite-test',
          registry: { kind: 'artifact-registry', repository: `app-${stage}`, immutableTags: true, scanOnPush: false },
          scan: { blockOn: 'DISABLED', timeoutSeconds: 300 },
        },
      ]),
    ),
  }),
})
const registry = (stage: string) => resolveRegistry({ config, stage, region: 'us-east5', project: 'boxlite-test' })
const fixture = (initial?: string, copied = DIGEST) => {
  let targetDigest = initial
  const calls: string[][] = []
  const run: Run = async (command, args) => {
    calls.push([command, ...args])
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
    if (command === 'gcloud') {
      if (args.slice(0, 3).join(' ') === 'artifacts repositories describe') return ok('True')
      if (args.slice(0, 4).join(' ') === 'artifacts docker images list')
        return ok(args[4]!.includes('/app-prod/') ? (targetDigest ?? '') : DIGEST)
      return ok()
    }
    if (args.slice(0, 3).join(' ') === 'buildx imagetools inspect')
      return ok(JSON.stringify({ digest: args[3]!.includes('/app-prod/') ? targetDigest : DIGEST }))
    if (args.slice(0, 3).join(' ') === 'buildx imagetools create') targetDigest = copied
    return ok()
  }
  return { run, calls }
}

test('a matching destination is idempotent after digest equality', async () => {
  const probe = fixture(DIGEST)
  const outcomes = await promote({
    config,
    tag: SHA,
    from: { stage: 'stage', registry: registry('stage') },
    to: { stage: 'prod', registry: registry('prod') },
    run: probe.run,
    log: () => {},
  })
  assert.equal(outcomes[0]!.built, false)
  assert.equal(
    probe.calls.filter((call) => call.slice(0, 4).join(' ') === 'docker buildx imagetools inspect').length,
    2,
  )
  assert.equal(
    probe.calls.some((call) => call.includes('create')),
    false,
  )
})

test('a copied manifest with a different digest fails instead of reporting success', async () => {
  const probe = fixture(undefined, OTHER)
  await assert.rejects(
    () =>
      promote({
        config,
        tag: SHA,
        from: { stage: 'stage', registry: registry('stage') },
        to: { stage: 'prod', registry: registry('prod') },
        run: probe.run,
        log: () => {},
      }),
    /digest|manifest/i,
  )
})

for (const failure of ['inspect denied', 'invalid digest', 'create failed']) {
  test(`promotion fails closed on ${failure}`, async () => {
    const probe = fixture()
    const run: Run = async (command, args, options) => {
      if (command === 'docker' && args.slice(0, 3).join(' ') === 'buildx imagetools inspect') {
        if (failure === 'inspect denied') return { code: 1, stdout: '', stderr: 'PERMISSION_DENIED' }
        if (failure === 'invalid digest') return { code: 0, stdout: '{"digest":"unexpected"}', stderr: '' }
      }
      if (
        command === 'docker' &&
        args.slice(0, 3).join(' ') === 'buildx imagetools create' &&
        failure === 'create failed'
      )
        return { code: 1, stdout: '', stderr: 'unsupported flag or transfer failed' }
      return probe.run(command, args, options)
    }
    await assert.rejects(
      () =>
        promote({
          config,
          tag: SHA,
          from: { stage: 'stage', registry: registry('stage') },
          to: { stage: 'prod', registry: registry('prod') },
          run,
          log: () => {},
        }),
      /digest|manifest|PERMISSION_DENIED|transfer failed/i,
    )
  })
}

for (const source of ['dev', 'stage']) {
  test(`${source} promotion refuses a conflicting target manifest`, async () => {
    const probe = fixture(OTHER)
    await assert.rejects(
      () =>
        promote({
          config,
          tag: SHA,
          from: { stage: source, registry: registry(source) },
          to: { stage: 'prod', registry: registry('prod') },
          run: probe.run,
          log: () => {},
        }),
      /digest|manifest/i,
    )
    assert.equal(
      probe.calls.some((call) => call.includes('create')),
      false,
    )
  })
  test(`${source} promotion copies the selected immutable manifest without architecture selection`, async () => {
    const probe = fixture()
    await promote({
      config,
      tag: SHA,
      from: { stage: source, registry: registry(source) },
      to: { stage: 'prod', registry: registry('prod') },
      run: probe.run,
      log: () => {},
    })
    const copy = probe.calls.find((call) => call.slice(0, 4).join(' ') === 'docker buildx imagetools create')
    assert.ok(copy, 'promotion did not copy the original manifest')
    assert.ok(copy.includes('--prefer-index=false'))
    assert.ok(copy.at(-1)!.endsWith(`@${DIGEST}`))
    assert.equal(
      probe.calls.some((call) => ['pull', 'build'].includes(call[1]!)),
      false,
    )
  })
}
