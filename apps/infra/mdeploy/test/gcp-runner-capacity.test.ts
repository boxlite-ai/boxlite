import assert from 'node:assert/strict'
import { access, writeFile } from 'node:fs/promises'
import test from 'node:test'
import type { ApplyEngineEvent, PulumiStack } from '../src/pulumi.ts'
import type { RunnerSize } from '../stack/runners.ts'
import {
  deployWithRunnerCapacityFallback,
  gcpRunnerAbsence,
  recordRunnerCandidates,
  runnerCapacityContext,
  verifyGcpRunnerIdentities,
} from '../src/gcp-runner-capacity.ts'

const scope = { app: 'boxlite-app', stage: 'dev', project: 'fixture-project', zone: 'us-east5-a' }
const instance = 'gcp:compute/instance:Instance'
const prefix = 'urn:pulumi:dev::boxlite-app::'
const fleet = ['Runner', 'Runner-runner-2', 'Runner-runner-3'].map((resourceName, index) => ({
  resourceName,
  nameTag: index === 0 ? 'boxlite-app-dev-runner' : `boxlite-app-dev-runner-${index + 1}`,
  controlPlaneRunnerName: index === 0 ? 'default' : `runner-${index + 1}`,
}))
const urnFor = (index: number) => `${prefix}${instance}::${fleet[index]!.resourceName}`
const disk = [{ source: 'projects/fixture-project/zones/us-east5-a/disks/runner-data-3', deviceName: 'boxlite-data' }]
const logCapacity = 'Error waiting for instance to create: '
const zoneShortage = "The zone 'projects/fixture-project/zones/us-east5-a' does not have enough resources available to fulfill the request."
const runnerToken = 'a'.repeat(64)
const tokenType = 'random:index/randomPassword:RandomPassword'
const regUrn = `${prefix}command:local:Command::RegisterExtraRunners`

type Fixture = {
  size?: RunnerSize
  primary?: string
  diagnostic?: string
  otherDiagnostic?: string
  eventOperation?: string
  omitPre?: boolean
  omitFailure?: boolean
  pending?: boolean
  alreadyCreated?: boolean
  corrupt?: boolean
  cloudInconclusive?: boolean
  unexpectedTarget?: string
  retryFails?: boolean
  checkpointMoves?: boolean
  unexpectedContinuation?: boolean
  firstSucceeds?: boolean
  cancelAt?: 'preview' | 'apply'
  checkIdentity?: boolean
}

const simulateDeployment = ({
  size = 'large', primary = 'n4-standard-16', diagnostic = zoneShortage, otherDiagnostic, eventOperation = 'create',
  omitPre, omitFailure, pending, alreadyCreated, corrupt, cloudInconclusive, unexpectedTarget, retryFails, checkpointMoves,
  unexpectedContinuation, firstSucceeds, cancelAt, checkIdentity,
}: Fixture = {}) => {
  const recovery = runnerCapacityContext(scope)
  recordRunnerCandidates(recovery, size, fleet)
  const initial = new Error('initial N4 apply failed')
  const calls: { op: string; target?: string[]; plan?: string; machine?: string; targetDependents?: boolean }[] = []
  const candidates: string[][] = []
  const upError = new Error('N4D zone resource pool exhausted')
  const retained = [{ urn: urnFor(0), type: instance }, { urn: urnFor(1), type: instance }]
  if (alreadyCreated) retained.push({ urn: urnFor(2), type: instance })
  const tokens = [{
    urn: `${prefix}${tokenType}::RunnerToken-runner-3`, type: tokenType,
    outputs: { result: { plaintext: JSON.stringify(runnerToken) } },
  }]
  const changedByWriter = { urn: `${prefix}example:resource:one::CompetingWriter`, type: 'example:resource:one' }
  const firstInputs = {
    project: scope.project, zone: scope.zone, name: fleet[2]!.nameTag,
    machineType: primary, attachedDisks: disk,
  }
  const metadata = { urn: urnFor(2), type: instance, op: eventOperation, new: { inputs: firstInputs } }
  let previews = 0
  let applies = 0
  let exports = 0
  const stack: PulumiStack = {
    setAllConfig: async () => {},
    destroy: async () => {},
    refresh: async () => {},
    async exportStack() {
      exports++
      return {
        deployment: {
          resources: [...retained, ...tokens, ...(checkpointMoves && exports >= 2 ? [changedByWriter] : [])],
          pending_operations: pending ? [{}] : [],
        },
      }
    },
    async up(options) {
      await recovery.beforeApply?.()
      applies++
      calls.push({
        op: 'up', plan: options.plan, target: options.target, targetDependents: options.targetDependents,
        machine: recovery.runnerMachines.get(fleet[2]!.resourceName),
      })
      if (applies === 2 && retryFails) throw upError
      if (applies === 2 && cancelAt === 'apply') {
        process.emit('SIGTERM')
        assert.equal(options.signal?.aborted, true)
      }
      if (applies !== 1 || firstSucceeds) return
      const emit = (event: unknown) => options.onEvent?.(event as ApplyEngineEvent)
      if (!omitPre) emit({ resourcePreEvent: { metadata } })
      emit({ diagnosticEvent: {
        severity: 'error', urn: urnFor(2),
        message: `  sdk-v2/provider2.go:571: sdk.helper_schema: ${logCapacity}${diagnostic}\n: provider=google-beta@9.36.1\n`,
      } })
      emit({ diagnosticEvent: {
        severity: 'error', urn: urnFor(2), message: `1 error occurred:\n\t* ${logCapacity}${diagnostic}\n\n`,
      } })
      if (otherDiagnostic) emit({ diagnosticEvent: { severity: 'error', urn: urnFor(1), message: otherDiagnostic } })
      if (!omitFailure) emit({ resOpFailedEvent: { metadata, steps: 1, status: 0 } })
      emit({ diagnosticEvent: { severity: 'error', message: 'update failed\n' } })
      if (corrupt) emit({ summaryEvent: { maybeCorrupt: true } })
      throw initial
    },
    async preview(options) {
      previews++
      const machine = recovery.runnerMachines.get(fleet[2]!.resourceName)
      calls.push({ op: 'preview', plan: options.plan, target: options.target, machine })
      assert.ok(options.plan)
      const resourcePlans: Record<string, unknown> = {
        [urnFor(0)]: { steps: ['same'] },
        [urnFor(1)]: { steps: ['same'] },
      }
      if (previews === 1) {
        resourcePlans[urnFor(2)] = {
          steps: ['create'],
          goal: { inputDiff: { adds: { ...firstInputs, machineType: unexpectedTarget ?? machine } } },
        }
      }
      if (previews === 2) resourcePlans[unexpectedContinuation ? urnFor(1) : regUrn] = { steps: ['update'] }
      await writeFile(options.plan, JSON.stringify({ resourcePlans }))
      if (previews === 1 && cancelAt === 'preview') {
        process.emit('SIGTERM')
        assert.equal(options.signal?.aborted, true)
      }
    },
  }
  const run = () => deployWithRunnerCapacityFallback({
    stack,
    recovery,
    onOutput: () => {},
    log: () => {},
    verifyRecovered: async (runners, signal) => {
      if (checkIdentity) await verifyGcpRunnerIdentities(stack, recovery, 'api.example.test', runners, signal)
    },
    assertAbsent: async (runners) => {
      if (cloudInconclusive) throw new Error('Unable to rule out an existing VM or pending GCE operation')
      candidates.push(runners.map((runner) => runner.urn))
    },
  })
  return { run, calls, initial, candidates, recovery }
}

for (const [size, vcpus] of [['large', 16], ['xlarge', 32], ['2xlarge', 64]] as const) {
  test(`GCP ${size} retries only the failed create on N4D with ${vcpus} vCPUs`, async () => {
    const { run, calls, candidates, recovery } = simulateDeployment({
      size, primary: `n4-standard-${vcpus}`,
      diagnostic: `A n4-standard-${vcpus} VM instance is currently unavailable in the us-east5-a zone.`,
    })
    await run()
    assert.deepEqual(candidates, [[urnFor(2)], [urnFor(2)]])
    assert.deepEqual(calls.map(({ op, target, machine }) => ({ op, target, machine })), [
      { op: 'up', target: undefined, machine: undefined },
      { op: 'preview', target: [urnFor(2)], machine: `n4d-standard-${vcpus}` },
      { op: 'up', target: [urnFor(2)], machine: `n4d-standard-${vcpus}` },
      { op: 'preview', target: undefined, machine: undefined },
      { op: 'up', target: undefined, machine: undefined },
      { op: 'preview', target: undefined, machine: undefined },
    ])
    assert.equal(calls[2]?.targetDependents, false)
    assert.equal(calls[1]?.plan, calls[2]?.plan)
    assert.equal(calls[3]?.plan, calls[4]?.plan)
    assert.equal(recovery.runnerMachines.size, 0)
    assert.equal(recovery.beforeApply, undefined)
    await assert.rejects(access(calls[1]!.plan!), { code: 'ENOENT' })
  })
}

test('a successful N4 apply needs no retry or extra preview', async () => {
  const { run, calls } = simulateDeployment({ firstSucceeds: true })
  await run()
  assert.deepEqual(calls.map(({ op }) => op), ['up'])
})

for (const [name, fixture] of Object.entries({
  permission: { diagnostic: 'Error 403: Missing compute.instances.create permission.' },
  quota: { diagnostic: 'Quota N4_CPUS exceeded.' },
  mixed: { diagnostic: `${zoneShortage}\nQuota N4_CPUS exceeded.` },
  'wrong zone': { diagnostic: zoneShortage.replace('us-east5-a', 'us-east5-b') },
  'wrong machine': { diagnostic: 'A n4-standard-32 VM instance is currently unavailable in the us-east5-a zone.' },
  'unrelated error': { otherDiagnostic: 'a different runner failed to update' },
  'no current create event': { omitPre: true },
  'no current failure event': { omitFailure: true },
  replacement: { eventOperation: 'create-replacement' },
  'ineligible size': { size: 'medium', primary: 'n4-standard-8' },
  'pending checkpoint operation': { pending: true },
  'ambiguous checkpoint': { corrupt: true },
  'instance present in the checkpoint': { alreadyCreated: true },
  'inconclusive cloud state': { cloudInconclusive: true },
} satisfies Record<string, Fixture>)) {
  test(`GCP preserves the original failure without retrying for ${name}`, async () => {
    const { run, calls, initial } = simulateDeployment(fixture)
    await assert.rejects(run(), (error) => error === initial)
    assert.deepEqual(calls.map(({ op }) => op), ['up'])
  })
}

for (const [name, fixture] of Object.entries({
  'wrong machine in saved plan': { unexpectedTarget: 'n4d-standard-64' },
  'concurrent checkpoint change': { checkpointMoves: true },
} satisfies Record<string, Fixture>)) {
  test(`GCP blocks the alternate create after preview when there is a ${name}`, async () => {
    const { run, calls, initial, recovery } = simulateDeployment(fixture)
    await assert.rejects(run(), (error) => error === initial)
    assert.deepEqual(calls.map(({ op }) => op), ['up', 'preview'])
    assert.equal(recovery.runnerMachines.size, 0)
  })
}

test('GCP makes only one alternate attempt when N4D is also out of capacity', async () => {
  const { run, calls, initial, recovery } = simulateDeployment({ retryFails: true })
  await assert.rejects(run(), (error) => error === initial)
  assert.deepEqual(calls.map(({ op }) => op), ['up', 'preview', 'up'])
  assert.equal(recovery.runnerMachines.size, 0)
})

test('GCP does not apply unrelated changes after the targeted create succeeds', async () => {
  const { run, calls, initial } = simulateDeployment({ unexpectedContinuation: true })
  await assert.rejects(run(), (error) => error === initial)
  assert.deepEqual(calls.map(({ op }) => op), ['up', 'preview', 'up', 'preview'])
})

test('GCP accepts documented CPU and memory capacity with suggested zones', async () => {
  const { run, calls } = simulateDeployment({
    diagnostic: 'A n4-standard-16 VM instance is currently unavailable in the us-east5-a zone, ' +
      'because of cpu_availability,memory_availability root cause(s). Consider trying your request in the ' +
      'us-east5-b, us-east5-c zone(s), which currently has capacity to accommodate your request.',
  })
  await run()
  assert.equal(calls.filter(({ op, target }) => op === 'up' && target?.includes(urnFor(2))).length, 1)
})

for (const cancelAt of ['preview', 'apply'] as const) {
  test(`GCP removes the private recovery plan after cancellation during ${cancelAt}`, async () => {
    const { run, calls, initial } = simulateDeployment({ cancelAt })
    await assert.rejects(run(), (error) => error === initial)
    assert.deepEqual(calls.map(({ op }) => op), cancelAt === 'preview' ? ['up', 'preview'] : ['up', 'preview', 'up'])
    await assert.rejects(access(calls[1]!.plan!), { code: 'ENOENT' })
  })
}

for (const [name, status, identity, succeeds] of [
  ['matching Runner and region', 200, { name: 'runner-3', region: 'us' }, true],
  ['wrong Runner', 200, { name: 'runner-2', region: 'us' }, false],
  ['wrong region', 200, { name: 'runner-3', region: 'eu' }, false],
  ['rejected token', 401, {}, false],
] as const) {
  test(`GCP reports recovery success only for an authenticated registration: ${name}`, async (t) => {
    const originalFetch = globalThis.fetch
    const fetch = t.mock.fn(async (url: string | URL | Request, options?: RequestInit) => {
      assert.equal(String(url), 'https://api.example.test/api/runners/me')
      assert.deepEqual(options?.headers, { authorization: `Bearer ${runnerToken}` })
      assert.equal(options?.redirect, 'error')
      return Response.json(identity, { status })
    })
    globalThis.fetch = fetch
    t.after(() => {
      globalThis.fetch = originalFetch
    })
    const { run, initial } = simulateDeployment({ checkIdentity: true })
    if (succeeds) await run()
    else await assert.rejects(run(), (error) => error === initial)
    assert.equal(fetch.mock.callCount(), 1)
  })
}

test('GCP does not start an apply if cancellation arrives while reading the saved plan', async (t) => {
  const parse = JSON.parse
  t.mock.method(JSON, 'parse', (source: string) => {
    const result = parse(source)
    if (result?.resourcePlans?.[urnFor(2)]?.steps?.[0] === 'create') process.emit('SIGTERM')
    return result
  })
  const { run, calls, initial } = simulateDeployment()
  await assert.rejects(run(), (error) => error === initial)
  assert.deepEqual(calls.map(({ op }) => op), ['up', 'preview'])
  await assert.rejects(access(calls[1]!.plan!), { code: 'ENOENT' })
})

test('GCP requires a complete zonal operations response before retrying a Runner', async () => {
  const recovery = runnerCapacityContext(scope)
  recordRunnerCandidates(recovery, 'large', [fleet[2]!])
  const available = { name: 'n4d-standard-16', kind: 'compute#machineType', zone: 'us-east5-a' }
  const requestFor = (operations: unknown, machine: unknown = available, instance: unknown = { error: { code: 404 } }) =>
    gcpRunnerAbsence(scope, {}, async () => async (url) => {
      if (url.endsWith('/operations')) return { status: 200, data: operations }
      return url.includes('/instances/') ? { status: 404, data: instance } : { status: 200, data: machine }
    })(recovery.candidates)
  const emptyOperations = { kind: 'compute#operations' }
  await requestFor(emptyOperations)
  const emptyWithWarning = { ...emptyOperations, warning: { code: 'NO_RESULTS_ON_PAGE' } }
  await requestFor(emptyWithWarning)
  await requestFor({ ...emptyWithWarning, items: [] })
  await assert.rejects(requestFor({ ...emptyWithWarning, nextPageToken: 'more' }), /operation/)
  await assert.rejects(requestFor({ ...emptyOperations, warning: { code: 'PARTIAL_SUCCESS' } }), /operation/)
  await assert.rejects(requestFor({
    ...emptyWithWarning,
    items: [{
      status: 'RUNNING',
      targetLink: 'https://compute.googleapis.com/compute/v1/projects/fixture-project/zones/us-east5-a/disks/unrelated',
    }],
  }), /operation/)
  await assert.rejects(requestFor(emptyOperations, 'invalid machine response'), /machine type/)
  await assert.rejects(requestFor(emptyOperations, { ...available, name: 'n4d-standard-32' }), /machine type/)
  await assert.rejects(requestFor(emptyOperations, { ...available, zone: 'us-east5-b' }), /machine type/)
  await assert.rejects(requestFor(emptyOperations, available, 'invalid not-found response'), /absent/)
  for (const unknown of ['unexpected response', {}, [], { kind: 'compute#operations', nextPageToken: 'more' }]) {
    await assert.rejects(requestFor(unknown), /operation/)
  }
  await assert.rejects(requestFor({
    kind: 'compute#operations',
    items: [{ status: 'RUNNING', targetLink: `https://compute.googleapis.com/compute/v1/projects/fixture-project/zones/us-east5-a/instances/${fleet[2]!.nameTag}` }],
  }), /pending/)
  for (const targetLink of ['', 'not-an-operation-url', 'https://elsewhere.test/compute/v1/projects/example']) {
    await assert.rejects(requestFor({
      kind: 'compute#operations', items: [{ status: 'RUNNING', targetLink }],
    }), /pending/)
  }
  await requestFor({
    kind: 'compute#operations',
    items: [{
      status: 'PENDING',
      targetLink: 'https://www.googleapis.com/compute/beta/projects/fixture-project/zones/us-east5-a/disks/unrelated',
    }],
  })
})
