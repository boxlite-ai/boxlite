import { createServer, Server, IncomingMessage, ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { Runner } from '../entities/runner.entity'
import { CompleteCreateAttempt, RunnerOutboundControl } from './outbound-control'

describe('revision-required outbound Runner HTTP boundary', () => {
  let server: Server
  let control: RunnerOutboundControl
  let endpoint: string
  let answer: (request: IncomingMessage, response: ServerResponse) => void
  let requests: { method: string; path: string; headers: IncomingMessage['headers']; body: unknown }[]
  const policy = { mode: 'enabled' as const, allow_net: ['*.example.com'] }
  const candidate = { revision: 'candidate-b', policy }
  const complete = {
    revision: 'complete-rev',
    admission: 'extended_ipv4' as const,
    policy: { mode: 'enabled' as const, allow_net: ['example.com:443'], deny_net: [] as string[] },
  }

  function reply(status: number, body: unknown, etag?: string | string[]) {
    answer = (_request, response) => {
      response.statusCode = status
      if (etag !== undefined) response.setHeader('ETag', etag)
      response.end(JSON.stringify(body))
    }
  }

  function status(patch: Record<string, unknown> = {}) {
    return {
      persisted: candidate,
      observed: { ...candidate, application_state: 'confirmed' },
      application_state: 'confirmed',
      capabilities: ['revision-v1'],
      ...patch,
    }
  }

  beforeEach(async () => {
    requests = []
    reply(200, policy, '"candidate-b"')
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      requests.push({
        method: request.method,
        path: request.url,
        headers: request.headers,
        body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null,
      })
      answer(request, response)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    control = new RunnerOutboundControl({ apiUrl: endpoint + '/', apiKey: 'synthetic-secret' } as Runner, 'box/1')
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('sends a complete create preparation over the dedicated authenticated route and preserves deny presence', async () => {
    const omitted = { mode: 'enabled' as const, allow_net: ['EXAMPLE.com:0443'] }
    const explicit = { ...omitted, deny_net: [] }
    reply(200, { snapshot: complete, deny_present: false })
    await expect(control.prepareCreate(complete.revision, omitted)).resolves.toEqual({
      snapshot: complete,
      deny_present: false,
    })
    reply(200, { snapshot: complete, deny_present: true })
    await expect(control.prepareCreate(complete.revision, explicit)).resolves.toEqual({
      snapshot: complete,
      deny_present: true,
    })
    expect(requests.map(({ body }) => body)).toEqual([omitted, explicit])
    for (const request of requests) {
      expect(request).toMatchObject({
        method: 'POST',
        path: '/v1/boxes/box%2F1/network/outbound/complete/prepare-create',
        headers: { authorization: 'Bearer synthetic-secret', 'x-boxlite-outbound-revision': complete.revision },
      })
    }
  })

  it.each([
    ['lost presence', { snapshot: complete, deny_present: false }],
    ['different revision', { snapshot: { ...complete, revision: 'other' }, deny_present: true }],
    ['legacy admission', { snapshot: { ...complete, admission: 'legacy' }, deny_present: true }],
    [
      'omitted policy rules',
      { snapshot: { ...complete, policy: { ...complete.policy, allow_net: [] } }, deny_present: true },
    ],
  ])('refuses a complete create acknowledgement with %s', async (_label, prepared) => {
    reply(200, prepared)
    await expect(control.prepareCreate(complete.revision, complete.policy)).rejects.toMatchObject({ status: 503 })
    expect(requests).toHaveLength(1)
  })

  it.each([
    ['different prefixes', 'fd42:424f:584c:1::2', 'fd42:424f:584c:2::1'],
    ['equal numeric addresses', 'fd42:424f:584c:1::2', 'fd42:424F:584c:0001:0:0:0:2'],
    ['guest subnet-router anycast', 'fd42:424f:584c:1::', 'fd42:424f:584c:1::1'],
    ['gateway subnet-router anycast', 'fd42:424f:584c:1::2', 'fd42:424f:584c:1::'],
  ])('refuses a prepared IPv6 plan with %s', async (_label, guest, gateway) => {
    const snapshot = { ...complete, admission: 'extended_dual_stack', ipv6: { interface: 'eth0', guest, gateway } }
    reply(200, { snapshot, deny_present: true })
    await expect(control.prepareCreate(complete.revision, complete.policy)).rejects.toMatchObject({ status: 503 })
  })

  it('accepts distinct prepared IPv6 addresses in the same /64', async () => {
    const snapshot = {
      ...complete,
      admission: 'extended_dual_stack',
      ipv6: { interface: 'eth0', guest: 'fd42::2', gateway: 'fd42:0:0:0:0:0:0:1' },
    }
    const prepared = { snapshot, deny_present: true }
    reply(200, prepared)
    await expect(control.prepareCreate(complete.revision, complete.policy)).resolves.toEqual(prepared)
  })

  it('refuses an explicit null deny list before network I/O', async () => {
    const invalid = { ...complete.policy, deny_net: null } as unknown as typeof complete.policy
    await expect(control.prepareCreate(complete.revision, invalid)).rejects.toMatchObject({ status: 400 })
    expect(requests).toHaveLength(0)
  })

  it('reports an old Runner as unsupported without falling back to the legacy route', async () => {
    reply(404, null)
    await expect(control.prepareCreate(complete.revision, complete.policy)).rejects.toMatchObject({
      status: 501,
      response: expect.objectContaining({ code: 'unsupported' }),
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].path).toBe('/v1/boxes/box%2F1/network/outbound/complete/prepare-create')
  })

  it('checks the complete snapshot revision against the strong ETag', async () => {
    reply(200, complete, '"complete-rev"')
    await expect(control.completeSnapshot()).resolves.toEqual(complete)
    reply(200, complete, 'W/"complete-rev"')
    await expect(control.completeSnapshot()).rejects.toMatchObject({ status: 503 })
  })

  it('binds versioned create and cancellation to the same complete identity', async () => {
    const attempt: CompleteCreateAttempt = {
      incarnation: 'target-a',
      attempt_id: 'attempt-a',
      generation: 2,
      prepared: { snapshot: complete, deny_present: true },
    }
    const box = { id: 'box/1', image: 'base', osUser: 'boxlite', memoryQuota: 1, storageQuota: 1, gpuQuota: 0 }
    reply(200, { attempt, outcome: 'installed', snapshot: complete })
    await expect(control.createComplete(attempt, box)).resolves.toEqual({ outcome: 'installed', snapshot: complete })
    reply(200, { attempt, outcome: 'no_effect', failure: 'unsupported' })
    await expect(control.cancelCompleteCreate(attempt)).resolves.toEqual({
      outcome: 'no_effect',
      failure: 'unsupported',
    })
    expect(requests.map(({ path, body }) => [path, body])).toEqual([
      ['/v1/boxes/box%2F1/network/outbound/complete/create', { attempt, box }],
      ['/v1/boxes/box%2F1/network/outbound/complete/cancel-create', attempt],
    ])
  })

  it('leaves stale or contradictory Runner create evidence unresolved', async () => {
    const attempt: CompleteCreateAttempt = {
      incarnation: 'target-a',
      attempt_id: 'attempt-a',
      generation: 2,
      prepared: { snapshot: complete, deny_present: true },
    }
    for (const proof of [
      { attempt: { ...attempt, generation: 1 }, outcome: 'no_effect' },
      { attempt: { ...attempt, prepared: { ...attempt.prepared, deny_present: false } }, outcome: 'no_effect' },
      { attempt, outcome: 'installed', snapshot: { ...complete, revision: 'other' } },
      { attempt, outcome: 'no_effect', snapshot: complete },
      { attempt, outcome: 'pending', failure: 'unsupported' },
    ]) {
      reply(200, proof)
      await expect(control.cancelCompleteCreate(attempt)).rejects.toMatchObject({ status: 503 })
    }
    reply(404, null)
    await expect(control.cancelCompleteCreate(attempt)).rejects.toMatchObject({ status: 501 })
    expect(requests.every(({ path }) => path.endsWith('/complete/cancel-create'))).toBe(true)
  })

  it('accepts confirmed complete status only when both lists and admission agree', async () => {
    const result = {
      persisted: complete,
      observed: { snapshot: complete, application_state: 'confirmed' },
      application_state: 'confirmed',
    }
    reply(200, result)
    await expect(control.completeStatus()).resolves.toEqual(result)
    reply(200, {
      ...result,
      observed: {
        snapshot: { ...complete, policy: { ...complete.policy, deny_net: ['example.net'] } },
        application_state: 'confirmed',
      },
    })
    await expect(control.completeStatus()).rejects.toMatchObject({ status: 503 })
    reply(200, { ...result, pending_revision: 'next-revision' })
    await expect(control.completeStatus()).rejects.toMatchObject({ status: 503 })
  })

  it('checks the Guest IPv6 plan in confirmed complete status', async () => {
    const ipv6 = { interface: 'eth0', guest: 'fd42:424f:584c:1::2', gateway: 'fd42:424f:584c:1::1' }
    const snapshot = { ...complete, admission: 'extended_dual_stack', ipv6 }
    const result = {
      persisted: snapshot,
      observed: { snapshot, application_state: 'confirmed' },
      application_state: 'confirmed',
    }
    reply(200, result)
    await expect(control.completeStatus()).resolves.toEqual(result)
    reply(200, {
      ...result,
      observed: {
        snapshot: { ...snapshot, ipv6: { ...ipv6, guest: 'fd42:424f:584c:1::3' } },
        application_state: 'confirmed',
      },
    })
    await expect(control.completeStatus()).rejects.toMatchObject({ status: 503 })
  })

  it('propagates the exact candidate through the authenticated dedicated resource', async () => {
    expect(await control.replace('initial', candidate)).toBe('applied')
    expect(requests).toEqual([
      {
        method: 'PUT',
        path: '/v1/boxes/box%2F1/network/outbound/snapshot',
        body: policy,
        headers: expect.objectContaining({
          authorization: 'Bearer synthetic-secret',
          'if-match': '"initial"',
          'x-boxlite-outbound-revision': 'candidate-b',
          'content-type': 'application/json',
        }),
      },
    ])
  })

  it('reads completion independently and preserves pending or uncertain state', async () => {
    reply(200, status())
    expect(await control.status()).toMatchObject({ application_state: 'confirmed', persisted: candidate })
    reply(200, status({ application_state: 'pending', pending_revision: 'candidate-c' }))
    expect(await control.status()).toMatchObject({ application_state: 'pending', pending_revision: 'candidate-c' })
    reply(200, status({ application_state: 'uncertain', observed: null, observation_error: 'backend unavailable' }))
    expect(await control.status()).toMatchObject({ application_state: 'uncertain', observed: null })
    expect(requests.every((request) => request.method === 'GET' && request.path.endsWith('/outbound/status'))).toBe(
      true,
    )
  })

  it.each([
    ['missing ETag', 200, policy, undefined],
    ['weak ETag', 200, policy, 'W/"candidate-b"'],
    ['duplicate ETag', 200, policy, ['"candidate-b"', '"candidate-b"']],
    ['wrong ETag', 200, policy, '"candidate-c"'],
    ['wrong policy', 200, { ...policy, allow_net: [] }, '"candidate-b"'],
    ['unsupported policy field', 200, { ...policy, proxy: null }, '"candidate-b"'],
    ['empty legacy ACK', 200, {}, '"candidate-b"'],
    ['accepted only', 202, policy, '"candidate-b"'],
    ['empty success', 204, null, '"candidate-b"'],
  ])('rejects %s without trying legacy PUT', async (_name, code, body, etag) => {
    reply(code as number, body, etag as string | string[] | undefined)
    await expect(control.replace('initial', candidate)).rejects.toThrow()
    expect(requests).toHaveLength(1)
    expect(requests[0].path).toBe('/v1/boxes/box%2F1/network/outbound/snapshot')
  })

  it('returns an explicit stale outcome without waiting for an error body', async () => {
    answer = (_request, response) => {
      response.writeHead(412)
      response.write('unfinished refusal body')
    }
    expect(await control.replace('initial', candidate)).toBe('precondition_failed')
    expect(requests).toHaveLength(1)
  })

  it.each([404, 405, 501])('classifies bare HTTP %s as unsupported', async (code) => {
    reply(code, null)
    await expect(control.replace('initial', candidate)).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ code: 'unsupported' }),
    })
    expect(requests).toHaveLength(1)
  })

  it('preserves typed refusals without disclosing Runner diagnostics', async () => {
    reply(409, { error: { code: 'invalid_state', message: 'synthetic-secret in upstream URL' } })
    await expect(control.replace('initial', candidate)).rejects.toMatchObject({
      status: 409,
      response: { code: 'invalid_state', message: 'Runner refused revisioned outbound control' },
    })
  })

  it.each([
    ['missing capability', { capabilities: [] }],
    ['bad phase', { application_state: 'done' }],
    ['bad persisted identity', { persisted: { ...candidate, revision: '' } }],
    ['missing observation', { observed: null }],
    ['unfinished observation', { observed: { ...candidate, application_state: 'pending' } }],
    ['different live identity', { observed: { ...candidate, revision: 'c', application_state: 'confirmed' } }],
    [
      'different live policy',
      { observed: { ...candidate, policy: { ...policy, allow_net: [] }, application_state: 'confirmed' } },
    ],
    ['pending evidence', { pending_revision: 'c' }],
    ['invalid pending identity', { application_state: 'pending', pending_revision: 'bad token' }],
    ['observation failure', { observation_error: 'unavailable' }],
    ['unknown policy capability', { persisted: { ...candidate, policy: { ...policy, deny_net: [] } } }],
  ])('rejects inconsistent status: %s', async (_name, patch) => {
    reply(200, status(patch))
    await expect(control.status()).rejects.toThrow()
  })

  it.each([
    ['invalid expected', 'bad\nheader', candidate],
    ['reused identity', 'candidate-b', candidate],
    ['reserved candidate', 'previous', { ...candidate, revision: 'initial' }],
    ['oversized candidate', 'previous', { ...candidate, revision: 'x'.repeat(129) }],
    ['invalid combination', 'previous', { ...candidate, policy: { mode: 'disabled', allow_net: ['example.com'] } }],
    ['invalid rule', 'previous', { ...candidate, policy: { ...policy, allow_net: ['https://example.com'] } }],
  ])('rejects %s before network I/O', async (_name, expected, next) => {
    await expect(control.replace(expected as string, next as typeof candidate)).rejects.toThrow()
    expect(requests).toHaveLength(0)
  })

  it('uses the proxy endpoint when the primary endpoint is absent', async () => {
    control = new RunnerOutboundControl({ proxyUrl: endpoint, apiKey: 'synthetic-secret' } as Runner, 'box1')
    expect(await control.replace('initial', candidate)).toBe('applied')
    expect(requests[0].path).toBe('/v1/boxes/box1/network/outbound/snapshot')
    expect(() => new RunnerOutboundControl({} as Runner, 'box1')).toThrow('no control endpoint')
  })

  it('does not forward bearer credentials through redirects', async () => {
    answer = (_request, response) => {
      response.writeHead(307, { Location: endpoint + '/credential-sink' })
      response.end()
    }
    await expect(control.replace('initial', candidate)).rejects.toThrow('uncertain')
    expect(requests).toHaveLength(1)
  })

  it('bounds the response body', async () => {
    reply(200, 'x'.repeat(65536))
    await expect(control.status()).rejects.toThrow('uncertain')
  })

  it('keeps response-body consumption inside the real ten-second deadline', async () => {
    let closed: () => void
    const connectionClosed = new Promise<void>((resolve) => {
      closed = resolve
    })
    answer = (_request, response) => {
      response.once('close', closed)
      response.writeHead(200, { ETag: '"candidate-b"' })
      response.write('{"mode":')
    }
    const started = Date.now()
    await expect(control.replace('initial', candidate)).rejects.toThrow('uncertain')
    await connectionClosed
    expect(Date.now() - started).toBeGreaterThanOrEqual(9500)
    expect(Date.now() - started).toBeLessThan(14000)
  }, 20000)
})
