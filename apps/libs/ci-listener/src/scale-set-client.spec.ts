/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { ActionsScaleSets } from './scale-set-client'
import { ScaleSetDiagnostics } from './scale-set-diagnostics'
import { ScaleSetWork } from './scale-set-controller'

describe('GitHub Actions scale set transport', () => {
  const base = 'https://pipelines.actions.githubusercontent.com/tenant/42'
  const queue = 'https://broker.actions.githubusercontent.com/messages'
  const sessionId = 'a5b047bd-cf28-4d03-a5b5-c58c8be4d4e7'
  const scope = 'https://github.com/example'
  const jwt =
    'prefix.' +
    Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') +
    '.suffix'
  let requests: jest.SpyInstance
  const registration = jest.fn(async () => 'registration-token')
  beforeEach(() => {
    registration.mockClear()
    requests = jest.spyOn(globalThis, 'fetch')
    requests.mockImplementation(() => {
      throw new Error('Unexpected request')
    })
  })
  afterEach(() => jest.restoreAllMocks())
  const json = (value: unknown) => new Response(JSON.stringify(value))
  const jsonWithRateLimit = () =>
    new Response(JSON.stringify({ message: 'API rate limit exceeded for private caller' }), { status: 403 })
  const admin = () => requests.mockResolvedValueOnce(json({ url: base, token: jwt }))
  const session = (token = 'queue-token') =>
    json({ sessionId, messageQueueUrl: queue, messageQueueAccessToken: token, statistics: { totalAssignedJobs: 2 } })
  it('polls the session queue, acquires only offered IDs and acknowledges the durable message', async () => {
    const client = new ActionsScaleSets(scope, registration)
    admin()
    requests.mockResolvedValueOnce(session())
    const active = await client.open(42, 'owner', new AbortController().signal)
    const job = {
      messageType: 'JobAvailable',
      runnerRequestId: 17,
      ownerName: 'example',
      repositoryName: 'repo',
      requestLabels: ['boxlite'],
    }
    requests.mockResolvedValueOnce(
      json({
        messageId: 0,
        messageType: 'RunnerScaleSetJobMessages',
        body: JSON.stringify([job]),
        statistics: { totalAssignedJobs: 2 },
      }),
    )
    const message = await active.poll(8, undefined)
    expect(message).toMatchObject({ id: 0, assigned: 2, available: [{ id: 17 }] })
    requests.mockResolvedValueOnce(json({ count: 1, value: [17] }))
    expect(await active.acquire([17])).toEqual([17])
    requests.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await active.ack(0)
    const [exchange, open, poll, acquire, ack] = requests.mock.calls
    expect(String(exchange[0])).toBe('https://api.github.com/actions/runner-registration')
    expect(new Headers(exchange[1].headers).get('authorization')).toBe('RemoteAuth registration-token')
    expect(String(open[0])).toBe(base + '/_apis/runtime/runnerscalesets/42/sessions?api-version=6.0-preview')
    expect(new Headers(open[1].headers).get('authorization')).toBe('Bearer ' + jwt)
    expect(String(poll[0])).toBe(queue)
    expect(new Headers(poll[1].headers).get('x-scalesetmaxcapacity')).toBe('8')
    expect(new Headers(acquire[1].headers).get('authorization')).toBe('Bearer queue-token')
    expect(acquire[1].body).toBe('[17]')
    expect(String(ack[0])).toBe(queue + '/0')
    expect(ack[1].method).toBe('DELETE')
  })
  it('treats an empty long poll as idle and refreshes only the expired session token', async () => {
    const client = new ActionsScaleSets(scope, registration)
    admin()
    requests.mockResolvedValueOnce(session())
    const active = await client.open(42, 'owner')
    requests.mockResolvedValueOnce(new Response(null, { status: 401 }))
    requests.mockResolvedValueOnce(session('refreshed'))
    requests.mockResolvedValueOnce(new Response(null, { status: 202 }))
    expect(await active.poll(8, 3)).toBeNull()
    expect(registration).toHaveBeenCalledTimes(1)
    expect(new Headers(requests.mock.calls.at(-1)[1].headers).get('authorization')).toBe('Bearer refreshed')
  })
  it.each([
    [
      'rate limit',
      () =>
        new Response('private upstream text', {
          status: 429,
          headers: {
            'retry-after': '7',
            'x-ratelimit-remaining': '0',
            'x-github-request-id': 'A123:BC45:1234:2345:ABCDEF12',
          },
        }),
      {
        reason: 'http',
        httpStatus: 429,
        retryAfterSeconds: 7,
        rateLimitRemaining: 0,
        githubRequestId: 'A123:BC45:1234:2345:ABCDEF12',
      },
    ],
    [
      'rate limit message',
      () => jsonWithRateLimit(),
      { reason: 'http', httpStatus: 403, githubMessage: 'API rate limit exceeded' },
    ],
    [
      'redirect',
      () => new Response(null, { status: 307, headers: { location: 'https://private.example/' } }),
      { reason: 'http', httpStatus: 307 },
    ],
    [
      'connection reset',
      () => {
        throw new TypeError('private endpoint', { cause: Object.assign(new Error(), { code: 'ECONNRESET' }) })
      },
      { reason: 'transport', transportCode: 'ECONNRESET' },
    ],
    ['invalid JSON', () => new Response('private invalid JSON'), { reason: 'response-json', httpStatus: 200 }],
    [
      'wrong message type',
      () => json({ messageId: 1, messageType: 'private remote value' }),
      { reason: 'message-type', httpStatus: 200, valueType: 'string' },
    ],
    [
      'invalid job ID',
      () =>
        json({
          messageId: 1,
          messageType: 'RunnerScaleSetJobMessages',
          body: JSON.stringify([{ messageType: 'JobAssigned', runnerRequestId: 0.5 }]),
        }),
      { reason: 'job-request-id', httpStatus: 200, valueType: 'number' },
    ],
  ] as const)('diagnoses poll failure for %s', async (_case, reply, expected) => {
    const client = new ActionsScaleSets(scope, registration)
    admin()
    requests.mockResolvedValueOnce(session())
    const active = await client.open(42, 'owner')
    requests.mockImplementationOnce(async () => reply())
    const failure = await active.poll(32).catch((error: unknown) => error)
    const log = new ScaleSetDiagnostics({
      scope: 'test',
      organization: 'tenant',
      installation: 1,
      label: 'boxlite',
      scaleSet: 42,
      messageId: null,
    }).failure(failure, 'poll')
    expect(log).toMatchObject(expected)
    expect(JSON.stringify(log)).not.toMatch(/private|queue-token|https:/)
  })
  it('rejects a service address outside GitHub before making an authenticated service request', async () => {
    const client = new ActionsScaleSets(scope, registration)
    requests.mockResolvedValueOnce(json({ url: 'https://example.invalid/service', token: jwt }))
    await expect(client.open(42, 'owner')).rejects.toThrow()
    expect(requests).toHaveBeenCalledTimes(1)
  })
  it('preserves a 64-bit job request ID through acquisition and refuses unoffered results', async () => {
    const client = new ActionsScaleSets(scope, registration)
    admin()
    requests.mockResolvedValueOnce(session())
    const active = await client.open(42, 'owner')
    const id = '9223372036854775807'
    requests.mockResolvedValueOnce(
      json({
        messageId: 7,
        messageType: 'RunnerScaleSetJobMessages',
        body:
          '[{"messageType":"JobAvailable","runnerRequestId":' +
          id +
          ',"ownerName":"example","repositoryName":"repo","requestLabels":["boxlite"]}]',
      }),
    )
    const message = await active.poll(2)
    expect(message!.available[0].id).toBe(id)
    requests.mockResolvedValueOnce(new Response('{"count":1,"value":[' + id + ']}'))
    await expect(active.acquire(message!.available.map((job) => job.id))).resolves.toEqual([id])
    expect(requests.mock.calls.at(-1)[1].body).toBe('[' + id + ']')
    requests.mockResolvedValueOnce(json({ count: 1, value: [18] }))
    await expect(active.acquire([17])).rejects.toThrow()
  })
  it('round-trips signed request IDs through available and settled messages and acquisition', async () => {
    const client = new ActionsScaleSets(scope, registration)
    admin()
    requests.mockResolvedValueOnce(session())
    const active = await client.open(42, 'owner')
    const tokens = ['-0', '-1', '-9007199254740993', '-9007199254740992', '-9223372036854775808', '9223372036854775807']
    const expected = [0, -1, ...tokens.slice(2)]
    const events = tokens.flatMap((id) => [
      `{"messageType":"JobAvailable","runnerRequestId":${id},"ownerName":"example","repositoryName":"repo","requestLabels":["boxlite"]}`,
      `{"messageType":"JobAssigned","runnerRequestId":${id}}`,
    ])
    requests.mockResolvedValueOnce(
      json({ messageId: 7, messageType: 'RunnerScaleSetJobMessages', body: '[' + events.join(',') + ']' }),
    )
    const message = await active.poll(8)
    expect(message?.settledRequests).toEqual(expected)
    const offered = message!.available.map((job) => job.id)
    expect(offered).toEqual(expected)
    const wireIds = '[' + expected.join(',') + ']'
    requests.mockResolvedValueOnce(new Response('{"count":6,"value":' + wireIds + '}'))
    await expect(active.acquire(offered)).resolves.toEqual(expected)
    expect(requests.mock.calls.at(-1)[1].body).toBe(wireIds)
    requests.mockResolvedValueOnce(json({ count: 1, value: [tokens[4]] }))
    await expect(active.acquire([tokens[4]])).rejects.toThrow()
    await expect(active.acquire([Number.MAX_SAFE_INTEGER + 1])).rejects.toThrow()
    await expect(active.acquire(['-01'])).rejects.toThrow()
  })
  it.each(['-9223372036854775809', '9223372036854775808', '1.00000000000000001', '1e1', '"9223372036854775807"'])(
    'rejects malformed signed request ID token %s',
    async (token) => {
      const client = new ActionsScaleSets(scope, registration)
      admin()
      requests.mockResolvedValueOnce(session())
      const active = await client.open(42, 'owner')
      const body = `[{"messageType":"JobStarted","runnerRequestId":${token}}]`
      requests.mockResolvedValueOnce(json({ messageId: 7, messageType: 'RunnerScaleSetJobMessages', body }))
      await expect(active.poll(1)).rejects.toMatchObject({ status: 200, details: { reason: 'job-request-id' } })
    },
  )
  it('propagates the rate reset and does not refresh a session on quota exhaustion', async () => {
    const client = new ActionsScaleSets(scope, registration)
    admin()
    requests.mockResolvedValueOnce(session())
    const active = await client.open(42, 'owner')
    const reset = Math.ceil(Date.now() / 1000) + 300
    requests.mockResolvedValueOnce(
      new Response(null, {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
      }),
    )
    await expect(active.poll(1)).rejects.toMatchObject({ status: 403, retryAt: reset * 1000 })
    expect(requests).toHaveBeenCalledTimes(3)
  })
  it('refuses to remove a same-name runner in another scale set', async () => {
    const client = new ActionsScaleSets(scope, registration),
      guard = jest.fn(async () => {})
    const identity = { id: 9, name: 'ci-jit-' + 'a'.repeat(32) }
    admin()
    requests.mockResolvedValueOnce(json({ count: 1, value: [{ ...identity, runnerScaleSetId: 43 }] }))
    await expect(client.registry(42, guard).remove(identity)).rejects.toThrow()
    expect(guard).not.toHaveBeenCalled()
    expect(requests.mock.calls.map(([, options]) => options.method)).toEqual(['POST', 'GET'])
  })
  it('releases the shared permit during registration propagation and then exchanges the same token', async () => {
    const client = new ActionsScaleSets(scope, registration),
      work = new ScaleSetWork(1)
    const signal = new AbortController().signal
    const beginning = Date.now()
    const now = jest.spyOn(Date, 'now').mockReturnValue(beginning)
    requests.mockResolvedValueOnce(new Response(null, { status: 401 }))
    admin()
    requests.mockResolvedValueOnce(session())
    const open = () => work.run(signal, () => client.open(42, 'owner'))
    const attempt = open()
    const healthy = work.run(signal, async () => 'ready')
    await expect(attempt).rejects.toMatchObject({ status: 401, retryAt: beginning + 1000 })
    await expect(healthy).resolves.toBe('ready')
    await expect(open()).rejects.toMatchObject({ retryAt: beginning + 1000 })
    expect(requests).toHaveBeenCalledTimes(1)
    now.mockReturnValue(beginning + 1000)
    await expect(open()).resolves.toMatchObject({ id: sessionId })
    expect(registration).toHaveBeenCalledTimes(1)
    expect(
      requests.mock.calls.slice(0, 2).map(([, options]) => new Headers(options.headers).get('authorization')),
    ).toEqual(['RemoteAuth registration-token', 'RemoteAuth registration-token'])
  })
})
