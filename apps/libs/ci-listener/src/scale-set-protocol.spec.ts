/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { ActionsScaleSets, ScaleSetSession } from './scale-set-client'

const base = 'https://pipelines.actions.githubusercontent.com/tenant'
const queue = 'https://broker.actions.githubusercontent.com/queue'
const sessionId = 'a5b047bd-cf28-4d03-a5b5-c58c8be4d4e7'
const session = {
  sessionId,
  runnerScaleSet: { id: 42 },
  messageQueueUrl: queue,
  messageQueueAccessToken: 'queue-token',
  statistics: { totalAssignedJobs: 2, totalAcquiredJobs: 0 },
}
const envelope = { messageId: 12, messageType: 'RunnerScaleSetJobMessages' }
const job = { messageType: 'JobAvailable', ownerName: 'org', repositoryName: 'repo', requestLabels: ['boxlite'] }
const runner = { name: 'ci-jit-' + 'a'.repeat(32), id: 7, runnerScaleSetId: 42 }
const set = { id: 42, name: 'boxlite-managed', runnerGroupId: 3, labels: [{ name: 'boxlite' }] }
const jwt = (claims: unknown) => 'header.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.signature'

describe('scale set protocol boundaries', () => {
  const registration = jest.fn(async () => 'registration-token')
  let wire: jest.SpyInstance<ReturnType<typeof fetch>, Parameters<typeof fetch>>
  let client: ActionsScaleSets
  beforeEach(() => {
    registration.mockClear()
    wire = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected request'))
    client = new ActionsScaleSets('https://github.com/org', registration)
  })
  afterEach(() => jest.restoreAllMocks())

  const broker = () => new ScaleSetSession(client, 42, session)
  const validAdmin = () =>
    wire.mockResolvedValueOnce(Response.json({ url: base, token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }) }))
  const withEvents = (events: unknown) => ({ ...envelope, body: JSON.stringify(events) })

  it.each([
    [null, 'message-id', 'null'],
    [{ ...envelope, messageId: -1 }, 'message-id', 'number'],
    [{ ...envelope, body: [] }, 'message-body', 'array'],
    [{ ...envelope, body: '{' }, 'message-body', 'string'],
    [withEvents({}), 'message-body', 'object'],
    [withEvents([null]), 'event-type', 'null'],
    [withEvents([{}]), 'event-type', 'missing'],
    [withEvents([{ ...job, ownerName: 7 }]), 'job-available', 'array'],
    [withEvents([{ ...job, repositoryName: null }]), 'job-available', 'array'],
    [withEvents([{ ...job, requestLabels: null }]), 'job-available', 'null'],
    [withEvents([{ ...job, requestLabels: [2] }]), 'job-available', 'array'],
    [{ ...envelope, statistics: false }, 'statistics', 'boolean'],
    [{ ...envelope, statistics: {} }, 'statistics', 'missing'],
  ] as const)('classifies a malformed response %j at its field boundary', async (value, reason, valueType) => {
    wire.mockResolvedValueOnce(Response.json(value))
    await expect(broker().poll(2)).rejects.toMatchObject({ status: 200, details: { reason, valueType } })
  })

  it('recognizes work only for named JIT runners, while settling each lifecycle request', async () => {
    wire.mockResolvedValueOnce(
      Response.json(
        withEvents([
          { messageType: 'JobStarted', runnerRequestId: 1, runnerName: runner.name, runnerId: runner.id },
          { messageType: 'JobCompleted', runnerRequestId: 2, runnerName: 'another-runner', runnerId: 8 },
          { messageType: 'JobStarted', runnerRequestId: 3, runnerName: null, runnerId: 10 },
          { messageType: 'JobStarted', runnerRequestId: 4, runnerName: runner.name, runnerId: 0 },
          { messageType: 'JobAssigned', runnerRequestId: 5 },
          { messageType: 'UnknownEvent' },
        ]),
      ),
    )
    await expect(broker().poll(2)).resolves.toEqual({
      id: 12,
      assigned: undefined,
      worked: [{ id: runner.id, name: runner.name }],
      available: [],
      settledRequests: [1, 2, 3, 4, 5],
    })
  })

  it.each([
    [{ message: 'You have exceeded a secondary rate limit: private caller' }, 'Secondary rate limit exceeded'],
    [{ message: 'Not Found' }, 'Not Found'],
    [{ message: 'Unexpected upstream body with private caller' }, undefined],
    [{ message: { code: 123 } }, undefined],
    [null, undefined],
  ] as const)('exposes only safe diagnostics for HTTP errors %j', async (body, safeMessage) => {
    wire.mockResolvedValueOnce(
      Response.json(body, {
        status: 403,
        headers: { 'x-vss-e2eid': sessionId, 'retry-after': 'tomorrow', 'x-ratelimit-remaining': 'unknown' },
      }),
    )
    const error = await broker()
      .poll(2)
      .catch((error: unknown) => error)
    expect(error).toMatchObject({ status: 403 })
    expect((error as { details: unknown }).details).toEqual({
      reason: 'http',
      githubRequestId: sessionId,
      ...(safeMessage ? { githubMessage: safeMessage } : {}),
    })
  })

  it('distinguishes a queue response stream failure from malformed JSON', async () => {
    wire.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('lost body'))
          },
        }),
      ),
    )
    await expect(broker().poll(2)).rejects.toMatchObject({ status: 200, details: { reason: 'response-read' } })
  })

  it('reports the long-poll deadline and propagates explicit caller cancellation separately', async () => {
    const deadline = new AbortController()
    const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    wire.mockImplementationOnce(async () => {
      deadline.abort()
      throw deadline.signal.reason
    })
    await expect(broker().poll(2)).rejects.toMatchObject({ details: { reason: 'timeout' } })
    expect(timeout).toHaveBeenCalledWith(120000)
    timeout.mockRestore()
    const caller = new AbortController()
    const reason = new Error('listener closed')
    caller.abort(reason)
    await expect(broker().poll(2, undefined, caller.signal)).rejects.toBe(reason)
    expect(wire).toHaveBeenCalledTimes(1)
  })

  it('preserves refresh failure status and retry deadline without replaying the expired token', async () => {
    const reset = Math.floor(Date.now() / 1000) + 240
    wire.mockResolvedValueOnce(new Response(null, { status: 401 }))
    validAdmin()
    wire.mockResolvedValueOnce(
      new Response(null, {
        status: 403,
        headers: { 'x-ratelimit-reset': String(reset), 'x-ratelimit-remaining': '0' },
      }),
    )
    await expect(broker().poll(2)).rejects.toMatchObject({
      status: 403,
      retryAt: reset * 1000,
      details: { reason: 'token-refresh' },
    })
    expect(wire.mock.calls.map(([url]) => String(url)).filter((url) => url === queue)).toHaveLength(1)
  })

  it('rejects session refreshes for a different original session', async () => {
    wire.mockResolvedValueOnce(new Response(null, { status: 401 }))
    validAdmin()
    wire.mockResolvedValueOnce(Response.json({ ...session, sessionId: 'a5b047bd-cf28-4d03-a5b5-c58c8be4d4e8' }))
    await expect(broker().poll(2)).rejects.toMatchObject({ details: { reason: 'token-refresh' } })
    expect(wire.mock.calls.map(([url]) => String(url)).filter((url) => url === queue)).toHaveLength(1)
  })

  it('validates capacity, cursor and acknowledgment IDs before sending a queue request', async () => {
    const session = broker()
    await expect(session.poll(-1)).rejects.toMatchObject({ details: { reason: 'poll-arguments' } })
    await expect(session.poll(0, -1)).rejects.toMatchObject({ details: { reason: 'poll-arguments' } })
    await expect(session.ack(-1)).rejects.toThrow()
    await expect(session.acquire([])).resolves.toEqual([])
    expect(wire).not.toHaveBeenCalled()
  })

  it('treats a successful DELETE with no definitive acknowledgement as uncertain', async () => {
    wire.mockResolvedValueOnce(new Response('accepted', { status: 200 }))
    await expect(broker().ack(12)).rejects.toMatchObject({ status: 200, uncertain: true })
    expect(wire).toHaveBeenCalledWith(queue + '/12', expect.objectContaining({ method: 'DELETE' }))
  })

  it.each([
    ['scope with credentials', 'https://private@github.com/org'],
    ['noncanonical repository path', 'https://github.com/org/..'],
  ])('rejects %s before connecting', (_name, scope) => {
    expect(() => new ActionsScaleSets(scope, registration)).toThrow('Invalid GitHub scale set scope')
    expect(registration).not.toHaveBeenCalled()
  })

  it('re-exchanges expired admin credentials but does not retry the mutation blindly', async () => {
    validAdmin()
    wire.mockResolvedValueOnce(new Response(null, { status: 401 }))
    await expect(client.open(42, 'owner')).rejects.toMatchObject({ status: 401 })
    validAdmin()
    wire.mockResolvedValueOnce(Response.json(session))
    await expect(client.open(42, 'owner')).resolves.toMatchObject({ initial: 2 })
    expect(registration).toHaveBeenCalledTimes(2)
  })

  it('obtains a new registration token after a failed exchange without retrying an uncertain request', async () => {
    wire.mockResolvedValueOnce(new Response(null, { status: 503 }))
    await expect(client.open(42, 'owner')).rejects.toMatchObject({ status: 503, uncertain: true })
    validAdmin()
    wire.mockResolvedValueOnce(Response.json(session))
    await expect(client.open(42, 'owner')).resolves.toMatchObject({ initial: 2 })
    expect(registration).toHaveBeenCalledTimes(2)
  })

  it.each([
    null,
    { url: base, token: 'contains spaces' },
    { url: base, token: 'missing-payload' },
    { url: base, token: jwt(null) },
    { url: base, token: jwt({}) },
    { url: base, token: jwt({ exp: 1 }) },
    { url: 0, token: jwt({ exp: 4_000_000_000 }) },
    { url: base + '?key=private', token: jwt({ exp: 4_000_000_000 }) },
  ])('never uses invalid registration metadata %j to access the service', async (reply) => {
    wire.mockResolvedValueOnce(Response.json(reply))
    await expect(client.open(42, 'owner')).rejects.toThrow()
    expect(wire).toHaveBeenCalledTimes(1)
  })

  it('validates original IDs, service paths and identity arguments before acquiring credentials', async () => {
    await expect(client.service('_apis/invalid?path', {})).rejects.toThrow()
    await expect(client.resolve('boxlite', 0, ['boxlite'])).rejects.toThrow()
    await expect(client.resolve('boxlite', 2, [])).rejects.toThrow()
    await expect(client.resolve('boxlite', 2, ['boxlite'], undefined, -1)).rejects.toThrow()
    await expect(client.open(42, '')).rejects.toThrow()
    const registry = client.registry(42, jest.fn())
    await expect(registry.create('other')).rejects.toThrow()
    await expect(registry.remove({ id: 0, name: runner.name })).rejects.toThrow()
    expect(registration).not.toHaveBeenCalled()
  })

  it.each([
    null,
    { count: 1, value: [] },
    { count: 2, value: [set, set] },
    { count: 1, value: [{ ...set, runnerGroupId: 99 }] },
    { count: 1, value: [{ ...set, labels: [{ name: 'other' }] }] },
  ])('rejects ambiguous or mismatched scale set ownership %j', async (reply) => {
    validAdmin()
    wire.mockResolvedValueOnce(Response.json(reply))
    await expect(client.resolve(set.name, set.runnerGroupId, ['boxlite'])).rejects.toThrow()
    expect(wire).toHaveBeenCalledTimes(2)
  })

  it.each([
    { id: 43, statistics: { totalAssignedJobs: 0 } },
    { id: 42, statistics: null },
    { id: 42, statistics: { totalAssignedJobs: -1 } },
    { id: 42, statistics: { totalAssignedJobs: 0, totalAcquiredJobs: -1 } },
  ])('rejects unrelated or malformed live statistics %j', async (reply) => {
    validAdmin()
    wire.mockResolvedValueOnce(Response.json(reply))
    await expect(client.currentStatistics(42, new AbortController().signal)).rejects.toThrow()
  })

  it.each([
    null,
    { ...session, sessionId: 'invalid' },
    { ...session, runnerScaleSet: null, statistics: undefined },
    { ...session, runnerScaleSet: { id: 43 } },
  ])('refuses to open a queue lacking a verified session and initial demand %j', async (reply) => {
    validAdmin()
    wire.mockResolvedValueOnce(Response.json(reply))
    await expect(client.open(42, 'owner')).rejects.toThrow()
    expect(wire).toHaveBeenCalledTimes(2)
  })

  it('skips absent runners and requires confirmed post-delete absence for existing runners', async () => {
    const before = jest.fn(async () => {})
    const registry = client.registry(42, before)
    validAdmin()
    const original = { id: runner.id, name: runner.name }
    const missing = () => Response.json({ count: 0, value: [] })
    const present = () => Response.json({ count: 1, value: [runner] })
    wire.mockResolvedValueOnce(missing())
    await expect(registry.remove(original)).resolves.toBeUndefined()
    expect(before).not.toHaveBeenCalled()
    wire
      .mockResolvedValueOnce(present())
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(present())
    await expect(registry.remove(original)).rejects.toThrow('deletion pending')
    expect(before).toHaveBeenCalledWith({ kind: 'remove', ...original })
  })

  it('refuses malformed JIT metadata after recording registration intent', async () => {
    const before = jest.fn(async () => {})
    validAdmin()
    wire.mockResolvedValueOnce(Response.json(null))
    await expect(client.registry(42, before).create(runner.name)).rejects.toThrow()
    expect(before).toHaveBeenCalledWith({ kind: 'register', name: runner.name })
  })
})
