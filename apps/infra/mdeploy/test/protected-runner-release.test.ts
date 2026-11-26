import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createOrdinaryCutoverBox,
  claimStandaloneRunnerUpdate,
  deployedProtectedReleaseKey,
  existingProtectedRunnerToken,
  readRunnerProcess,
  servingApiRevision,
  standaloneUpdateClaimId,
  verifyRunnerEnrollment,
  verifyRunnerProcess,
  verifyServingApiLogin,
  verifyServingRunnerCompletion,
} from '../src/protected-runner-release.ts'
import { waitForRunnerPolicyCompliance } from '../src/upgrade-runners.ts'

const runnerId = 'c536e70c-e230-4499-9f9c-d4a49ea85775'
const processId = '55b491dd-dfb8-49b4-ab41-396109e78280'
const digest = 'd'.repeat(64)
const revision = 'boxlite-dev-api-001'
const sample = { pid: 912, start_ticks: 582963, process_id: processId, executable_digest: digest }

const release = {
  sample: () => sample,
  runnerId,
  expectedDigest: digest,
  apiUrl: 'https://api.dev.example.test',
  adminApiKey: 'stage-admin-fixture',
  revision,
}

test('reads existing default and numbered Runner tokens from the selected stack state', () => {
  const password = 'random:index/randomPassword:RandomPassword'
  const resource = (name: string, token: string) => ({
    type: password,
    urn: `urn:pulumi:dev::fixture::${password}::RunnerToken-${name}`,
    outputs: { result: { plaintext: JSON.stringify(token) } },
  })
  const state = { deployment: { resources: [resource('default', 'a'.repeat(64)), resource('runner-2', 'b'.repeat(64))] } }
  assert.equal(existingProtectedRunnerToken(state, 'default'), 'a'.repeat(64))
  assert.equal(existingProtectedRunnerToken(state, 'runner-2'), 'b'.repeat(64))
  assert.throws(() => existingProtectedRunnerToken(state, 'runner-3'), /No existing Runner token/)
})

test('a lost claim reply retries with the exact operation and artifact', async () => {
  const key = standaloneUpdateClaimId(processId, ['stage', digest, ['base', 'fleet']])
  assert.notEqual(standaloneUpdateClaimId(processId, ['stage', '0'.repeat(64), ['base', 'fleet']]), key)
  let active: string | undefined
  const request: typeof fetch = async (input, options) => {
    if (options?.method === 'POST') {
      const { claimId: candidate, resume } = JSON.parse(String(options.body))
      if (active === undefined) {
        assert.equal(resume, false)
        active = candidate
        throw new Error('response lost')
      }
      assert.equal(resume, true)
      return new Response(null, { status: active === candidate ? 204 : 409 })
    }
    assert.ok(String(input).endsWith(`/${active}`))
    active = undefined
    return new Response(null, { status: 204 })
  }
  const claim = (resume: boolean) => claimStandaloneRunnerUpdate(release.apiUrl, release.adminApiKey, key, resume, request)
  await assert.rejects(claim(false), /response lost/)
  const finish = await claim(true)
  await finish()
  assert.equal(active, undefined)
})

test('waits for the declared OS Config revision and all required policies', () => {
  const policies = ['runner-binary', 'runner-unit-env']
  let reads = 0
  waitForRunnerPolicyCompliance({
    targets: ['dev-runner'], identity: 'candidate', project: 'fixture', zone: 'us-central1-a',
    assignment: 'dev-policy', revision: 'new', policies, sleep: () => {}, log: () => {},
    run: () => {
      reads++
      return { ok: true, status: 0, stderr: '', stdout: JSON.stringify({
        osPolicyAssignment: `projects/fixture/locations/us-central1-a/osPolicyAssignments/dev-policy@${reads === 1 ? 'old' : 'new'}`,
        osPolicyCompliances: policies.slice(0, reads === 2 ? 1 : 2).map((osPolicyId) => ({
          osPolicyId, complianceState: 'COMPLIANT',
        })),
      }) }
    },
  })
  assert.equal(reads, 3)
})

test('reads only a valid release key from the existing Cloud Run restore job', () => {
  const context = { project: 'fixture-project', region: 'us-central1', job: 'restore-job' }
  const job = (env: { name: string; value: string }[]) =>
    JSON.stringify({ spec: { template: { spec: { template: { spec: { containers: [{ env }] } } } } } })
  const accepted = job([{ name: 'PROTECTED_RELEASE_KEY', value: '4321.2' }])
  const result = deployedProtectedReleaseKey({
    ...context,
    run: (file, args) => {
      assert.equal(file, 'gcloud')
      assert.deepEqual(args.slice(0, 4), ['run', 'jobs', 'describe', context.job])
      assert.ok(args.includes('--format=json(spec.template.spec.template.spec.containers[0].env)'))
      return { ok: true, status: 0, stdout: accepted, stderr: '' }
    },
  })
  assert.equal(result, '4321.2')
  assert.throws(() => deployedProtectedReleaseKey({
    ...context,
    run: () => ({ ok: true, status: 0, stdout: job([]), stderr: '' }),
  }), /no valid release key/)
})

test('release samples the final process on both sides of API mTLS verification', async () => {
  const events: string[] = []
  const result = await verifyRunnerProcess({
    ...release,
    sample() {
      events.push('host')
      return sample
    },
    request: async (input, init) => {
      events.push('API')
      const url = new URL(String(input))
      assert.equal(url.pathname, `/api/admin/runners/${runnerId}/protected-release`)
      assert.equal(url.searchParams.get('processId'), processId)
      assert.equal(url.searchParams.get('executableDigest'), digest)
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer stage-admin-fixture')
      return Response.json({ revision })
    },
  })
  assert.deepEqual(events, ['host', 'API', 'host'])
  assert.deepEqual(result, sample)
})

test('refuses the wrong bytes, API revision or process start ticks', async () => {
  const accept = async () => Response.json({ revision })
  await assert.rejects(
    verifyRunnerProcess({
      ...release,
      sample: () => ({ ...sample, executable_digest: 'a'.repeat(64) }),
      request: async () => assert.fail('wrong bytes must fail before contacting the API'),
    }),
    /digest differs/,
  )
  await assert.rejects(
    verifyRunnerProcess({ ...release, request: async () => Response.json({ revision: 'old-api' }) }),
    /API revision did not verify/,
  )
  const captures = [sample, { ...sample, start_ticks: sample.start_ticks + 1 }]
  await assert.rejects(
    verifyRunnerProcess({ ...release, sample: () => captures.shift()!, request: accept }),
    /Runner restarted/,
  )
})

test('samples over the existing IAP transport and refuses malformed evidence', () => {
  const host = { target: 'boxlite-dev-runner', project: 'boxlite-dev', zone: 'us-central1-a' }
  assert.deepEqual(readRunnerProcess(host, (file, args) => {
    assert.equal(file, 'gcloud')
    assert.ok(args.includes(host.target))
    assert.ok(args.includes('--tunnel-through-iap'))
    return { ok: true, status: 0, stdout: JSON.stringify(sample), stderr: '' }
  }), sample)
  assert.throws(
    () => readRunnerProcess(host, () => ({ ok: true, status: 0, stdout: '{"pid":1}', stderr: '' })),
    /invalid Runner process sample/,
  )
})

test('preflight requires the inventory and existing Runner credential to identify the same V2 slot', async () => {
  const slot = { runnerId, name: 'runner-2', apiKey: 'runner-fixture' }
  const existing = { id: runnerId, name: slot.name, apiVersion: '2' }
  const credentials = new Map<string, string | null>()
  await verifyRunnerEnrollment(release.apiUrl, release.adminApiKey, [slot], async (input, init) => {
    credentials.set(new URL(String(input)).pathname, new Headers(init?.headers).get('authorization'))
    return Response.json(existing)
  })
  assert.equal(credentials.get(`/api/admin/runners/${runnerId}`), 'Bearer stage-admin-fixture')
  assert.equal(credentials.get('/api/runners/me'), 'Bearer runner-fixture')
  await assert.rejects(
    verifyRunnerEnrollment(release.apiUrl, release.adminApiKey, [slot], async (input) =>
      Response.json(String(input).endsWith('/me') ? { ...existing, id: processId } : existing)),
    /do not match enrollment/,
  )
})

test('requires every serving request to target the expected Cloud Run revision', () => {
  const read = (traffic: { percent: number; revisionName: string }[]) => servingApiRevision({
    service: 'boxlite-dev-api',
    project: 'boxlite-dev',
    region: 'us-central1',
    run: () => ({
      ok: true,
      status: 0,
      stdout: JSON.stringify({ status: { latestReadyRevisionName: revision, traffic } }),
      stderr: '',
    }),
  })
  assert.equal(read([{ revisionName: revision, percent: 100 }]), revision)
  assert.throws(() => read([{ revisionName: 'old-api', percent: 100 }]), /all traffic/)
  assert.throws(() => read([
    { revisionName: revision, percent: 90 },
    { revisionName: 'old-api', percent: 10 },
  ]), /all traffic/)
})

test('database fencing requires the live compatible API revision and runtime login', async () => {
  const login = {
    apiUrl: release.apiUrl, adminApiKey: release.adminApiKey, revision,
    expectedLogin: 'boxlite_runtime', timeout: 1000,
  }
  await assert.rejects(verifyServingApiLogin({
    ...login, request: async () => Response.json({ revision, databaseLogin: 'boxlite' }),
  }), /protected runtime login/)
  await verifyServingApiLogin({
    ...login, request: async () => Response.json({ revision, databaseLogin: login.expectedLogin }),
  })
})

test('database fencing requires the exact cutover Box completion from the compatible API revision', async () => {
  const boxId = 'abc123xyz789'
  const check = { apiUrl: release.apiUrl, adminApiKey: release.adminApiKey, revision, boxId, timeout: 1_000 }
  const completion = { revision, boxId, runnerId, jobId: processId }
  const request = (result: object): typeof fetch => async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.pathname, `/api/admin/runners/protected-release/serving/${boxId}`)
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer stage-admin-fixture')
    return Response.json(result)
  }
  await verifyServingRunnerCompletion({ ...check, request: request(completion) })
  await assert.rejects(verifyServingRunnerCompletion({
    ...check, request: request({ ...completion, revision: 'former-revision' }),
  }), /does not match/)
  await assert.rejects(verifyServingRunnerCompletion({
    ...check, request: request({ ...completion, boxId: 'anotherboxid' }),
  }), /does not match/)
})

test('ordinary cutover creates a fresh bounded Box in the existing test organization and cleans it up', async () => {
  const calls: string[] = []
  const organization = '08a9d69e-a216-4e05-9ca3-4ee12844b8ca'
  const collection = `/v1/${organization}/boxes`
  const name = `e2e-v2-cutover-${processId}`
  let committed = false
  const args = {
    apiUrl: release.apiUrl, adminApiKey: release.adminApiKey, testApiKey: 'existing-test-org',
    image: 'ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0',
    name, signal: AbortSignal.timeout(10_000),
    request: (async (input, init) => {
      const path = new URL(String(input)).pathname
      calls.push(path)
      const key = init?.method === 'POST' ? release.adminApiKey : 'existing-test-org'
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${key}`)
      if (path === '/v1/me') return Response.json({ path_prefix: organization })
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      if (path.endsWith(`/${name}`)) {
        return committed ? Response.json({ box_id: 'abc123xyz789' }) : new Response(null, { status: 404 })
      }
      assert.equal(init?.method, 'POST')
      assert.equal(path, `${collection}/_protected-release`)
      const body = JSON.parse(String(init?.body))
      assert.deepEqual(Object.keys(body).sort(), ['image', 'name'])
      assert.equal(body.name, name)
      committed = true
      throw new Error('ordinary create response lost')
    }) satisfies typeof fetch,
  }
  await assert.rejects(createOrdinaryCutoverBox(args), /response lost/)
  const probe = await createOrdinaryCutoverBox(args)
  assert.equal(probe.boxId, 'abc123xyz789')
  await probe.cleanup()
  assert.deepEqual(calls, [
    '/v1/me', `${collection}/${name}`, `${collection}/_protected-release`,
    '/v1/me', `${collection}/${name}`, `${collection}/abc123xyz789`,
  ])
})
