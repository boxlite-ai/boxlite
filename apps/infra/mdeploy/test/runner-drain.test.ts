import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { drainRunners } from '../src/runner-drain.ts'

const cwd = fileURLToPath(new URL('../..', import.meta.url))
const environment = { MSTAGE_CONFIG: fileURLToPath(new URL('../../.mstage.config.example.json', import.meta.url)) }
const key = 'test-admin-key'
const fleet = ['default', 'runner-2', 'runner-3'].map((name, index) => ({
  name,
  id: `00000000-0000-4000-8000-00000000000${index + 1}`,
  region: 'us',
  state: 'ready',
}))
type Input = Parameters<typeof drainRunners>[0]
const setup = (overrides: Partial<Input> = {}, respond?: (index: number) => Response) => {
  const calls: { url: string; init: RequestInit }[] = []
  const logs: string[] = []
  let reads = 0
  const run = (argv = ['--stage', 'dev', '--runners', 'default,runner-2']) =>
    drainRunners({
      argv,
      cwd,
      environment,
      log: (line) => logs.push(line),
      checkLogin: async () => 0,
      resolveHomeWith: async () => ({ backend: {} }) as Awaited<ReturnType<NonNullable<Input['resolveHomeWith']>>>,
      readStore: async ({ app, stage }) => {
        reads++
        assert.equal(app, 'boxlite-app')
        assert.ok(['dev', 'dev2', 'prod'].includes(stage))
        return { STACK_DOMAIN: 'boxlite.example', ADMIN_API_KEY: key }
      },
      fetchWith: async (url, init) => {
        calls.push({ url: String(url), init: init! })
        return (
          respond?.(calls.length) ?? (calls.length === 1 ? Response.json(fleet) : new Response(null, { status: 204 }))
        )
      },
      ...overrides,
    })
  return { run, calls, logs, reads: () => reads }
}

test('drain requests resolve exact names, deduplicate, and stop after acceptance', async () => {
  const { run, calls, logs, reads } = setup()
  assert.equal(await run(['--stage', 'dev', '--runners', ' default,runner-2,default ']), 0)
  assert.equal(reads(), 1)
  assert.deepEqual(
    calls.map(({ url, init }) => [init.method, url]),
    [
      ['GET', 'https://api.boxlite.example/api/admin/runners?regionId=us'],
      ...fleet.slice(0, 2).map(({ id }) => ['PATCH', `https://api.boxlite.example/api/admin/runners/${id}/draining`]),
    ],
  )
  for (const { init } of calls) {
    assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${key}`)
    assert.equal(init.redirect, 'error')
    assert.ok(init.signal instanceof AbortSignal)
    if (init.method === 'PATCH') assert.deepEqual(JSON.parse(String(init.body)), { draining: true })
    else assert.equal(init.body, undefined)
  }
  assert.equal(logs.filter((line) => line.includes('draining=true accepted')).length, 2)
  assert.ok(logs.every((line) => !line.includes(key)))
})

test('drain input and protected-stage refusals happen before cloud reads', async () => {
  const { run, reads, calls } = setup()
  for (const names of ['', '*', 'default,', 'default;echo bad', '$(whoami)']) {
    await assert.rejects(run(['--stage', 'dev', '--runners', names]), /explicit runner names|requires a value/)
  }
  await assert.rejects(run(['--stage', 'prod', '--runners', 'default']), /protected/)
  assert.equal(reads(), 0)
  assert.equal(calls.length, 0)
  assert.equal(await run(['--stage', 'prod', '--runners', 'default', '--confirm']), 0)
})

test('drain validates every target before the first mutation', async () => {
  for (const list of [
    fleet.slice(0, 1),
    [...fleet, fleet[1]],
    [fleet[0], { ...fleet[1], state: 'decommissioned' }],
    [fleet[0], { ...fleet[1], id: '../other' }],
    [fleet[0], { ...fleet[1], region: 'another-region' }],
    [fleet[0], { ...fleet[1], state: null }],
    null,
  ]) {
    const { run, calls } = setup({}, () => Response.json(list))
    await assert.rejects(run(), /exactly once|decommissioned|invalid API response|must be an array/)
    assert.deepEqual(
      calls.map(({ init }) => init.method),
      ['GET'],
    )
  }
})

test('drain uses the stage API region and works through the GCP scope', async () => {
  const region = 'eu & east'
  const { run, calls } = setup(
    {
      readStore: async () => ({ STACK_DOMAIN: 'boxlite.example', ADMIN_API_KEY: key, DEFAULT_REGION_ID: region }),
      resolveHomeWith: async ({ scope }) => {
        assert.equal(scope.home, 'gcp')
        return { backend: {} } as Awaited<ReturnType<NonNullable<Input['resolveHomeWith']>>>
      },
    },
    (index) =>
      index === 1 ? Response.json(fleet.map((runner) => ({ ...runner, region }))) : new Response(null, { status: 204 }),
  )
  await run(['--stage', 'dev2', '--runners', 'default'])
  assert.equal(new URL(calls[0].url).searchParams.get('regionId'), region)
})

test('drain refuses missing credentials or an unsafe origin before API access', async () => {
  const invalid: Record<string, string>[] = [
    { STACK_DOMAIN: 'boxlite.example' },
    { STACK_DOMAIN: 'example.com@attacker.example/path', ADMIN_API_KEY: key },
  ]
  for (const values of invalid) {
    const { run, calls } = setup({ readStore: async () => values })
    await assert.rejects(run(), /ADMIN_API_KEY|STACK_DOMAIN/)
    assert.equal(calls.length, 0)
  }
  const signedOut = setup({ checkLogin: async () => 1 })
  await assert.rejects(signedOut.run(), /sign-ins/)
  assert.equal(signedOut.reads(), 0)
})

test('drain HTTP and JSON failures are bounded and do not echo server bodies', async () => {
  for (const status of [302, 401, 403, 404, 500]) {
    const { run, calls } = setup({}, () => new Response(key, { status }))
    await assert.rejects(
      run(),
      (error: Error) => error.message.includes(`HTTP ${status}`) && !error.message.includes(key),
    )
    assert.equal(calls.length, 1)
  }
  await assert.rejects(setup({}, () => new Response(key)).run(), /^Error: Runner list is not valid JSON$/)
  const failed = setup({
    fetchWith: async () => {
      throw new Error(`redirect/timeout ${key}`)
    },
  })
  await assert.rejects(
    failed.run(),
    (error: Error) => error.message.includes('network, timeout or redirect') && !error.message.includes(key),
  )
})

test('drain partial failure preserves accepted changes and sends no subsequent request', async () => {
  const { run, calls, logs } = setup({}, (index) =>
    index === 1 ? Response.json(fleet) : new Response(null, { status: index === 3 ? 409 : 204 }),
  )
  await assert.rejects(run(['--stage', 'dev', '--runners', 'default,runner-2,runner-3']), /HTTP 409/)
  assert.equal(calls.length, 3)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /^default .*draining=true accepted$/)
})

test('drain masks the admin credential in GitHub before requesting state changes', async () => {
  const { run, logs } = setup({ environment: { ...environment, GITHUB_ACTIONS: 'true' } })
  await run()
  assert.equal(logs[0], `::add-mask::${key}`)
  assert.ok(logs.slice(1).every((line) => !line.includes(key)))
})

test('drain workflow only dispatches state requests under the deployment lock', () => {
  const workflow = load(
    readFileSync(new URL('../../../../.github/workflows/runner-drain.yml', import.meta.url), 'utf8'),
  ) as any
  const deployment = load(
    readFileSync(new URL('../../../../.github/workflows/mdeploy-all.yml', import.meta.url), 'utf8'),
  ) as any
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch'])
  assert.deepEqual(workflow.concurrency, deployment.concurrency)
  assert.deepEqual(Object.keys(workflow.jobs), ['drain'])
  const job = workflow.jobs.drain
  assert.equal(job.environment, '${{ inputs.stage }}')
  assert.match(job.if, /github.ref == 'refs\/heads\/main' \|\| inputs.stage == 'dev'/)
  const step = job.steps.find((step: any) => step.name === 'Request drain')
  assert.equal(step.env.RUNNER_NAMES, '${{ inputs.runner_names }}')
  assert.match(step.run, /--runners "\$RUNNER_NAMES"/)
  assert.match(step.run, /npm run --silent runner:drain -- "\$\{args\[@\]\}"/)
  const commands = job.steps.map((step: any) => step.run ?? '').join('\n')
  assert.doesNotMatch(
    commands,
    /\$\{\{ inputs\.|npm run (?:--silent )?mdeploy\b|\b(?:while|until|sleep|curl|delete|destroy)\b/,
  )
})
