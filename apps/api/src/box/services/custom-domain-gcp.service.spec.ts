/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { CustomDomainGcpService } from './custom-domain-gcp.service'
import { CustomDomainRow } from './custom-domain-policy'

const request = jest.fn()
jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({ getClient: async () => ({ request }) })),
}))
const parent = 'projects/test-project/locations/global'

describe('GCP custom domain reconciliation', () => {
  let provider: CustomDomainGcpService
  let row: CustomDomainRow
  let resources: Map<string, any>
  beforeEach(() => {
    row = {
      id: '00000000-0000-4000-8000-000000000001',
      hostname: 'app.example.com',
      generation: 1,
      phase: 'pending_certificate_dns',
      provider_state: {},
      deleted_at: null,
    } as CustomDomainRow
    provider = new CustomDomainGcpService({
      getOrThrow: () => ({ project: 'test-project', certificateMap: 'proxy' }),
    } as never)
    resources = new Map()
    request.mockReset().mockImplementation(async ({ url, method, data }) => {
      const path = url.split('/v1/')[1]
      if (method === 'GET') {
        if (path.includes('/operations/')) return { data: { done: true } }
        if (!resources.has(path)) throw { response: { status: 404 } }
        return { data: resources.get(path) }
      }
      if (method === 'DELETE') resources.delete(path)
      if (method === 'POST') {
        const [collection, query] = path.split('?')
        const name = `${collection}/${query.split('=')[1]}`
        resources.set(name, {
          ...data,
          name,
          state: 'ACTIVE',
          expireTime: '2030-01-01T00:00:00Z',
          ...(data.managed ? { managed: { ...data.managed, state: 'ACTIVE' } } : {}),
          dnsResourceRecord: {
            name: '_acme-challenge_project.app.example.com.',
            type: 'CNAME',
            data: 'issued.authorize.certificatemanager.goog.',
          },
        })
      }
      return { data: { name: `${parent}/operations/operation-1` } }
    })
  })
  async function step() {
    const result = await provider.reconcile(row)
    row.provider_state = result.state
    row.phase = result.phase
    return result
  }
  it('progresses deterministic resources, exposes returned authorization, and waits for ACTIVE', async () => {
    let result = await step()
    expect(result.expires).toBeNull()
    result = await step()
    expect(result.state.authorizationRecord).toEqual({
      name: '_acme-challenge_project.app.example.com.',
      type: 'CNAME',
      value: 'issued.authorize.certificatemanager.goog.',
    })
    for (let i = 0; i < 3; i++) result = await step()
    expect(result).toMatchObject({ phase: 'ready', expires: '2030-01-01T00:00:00Z' })
    expect(resources.size).toBe(3)
    expect(request.mock.calls.filter(([call]) => call.method === 'POST')).toHaveLength(3)
    await step()
    expect(request.mock.calls.filter(([call]) => call.method === 'POST')).toHaveLength(3)
  })
  it('cleans only owned resources in dependency order and retains a tombstone sweep', async () => {
    for (let i = 0; i < 5; i++) await step()
    row.deleted_at = new Date()
    for (let i = 0; i < 3; i++) expect((await step()).cleaned).toBe(false)
    expect((await step()).cleaned).toBe(true)
    const deleted = request.mock.calls.filter(([call]) => call.method === 'DELETE').map(([call]) => call.url)
    expect(deleted[0]).toContain('/certificateMapEntries/')
    expect(deleted[1]).toContain('/certificates/')
    expect(deleted[2]).toContain('/dnsAuthorizations/')
    expect(resources.size).toBe(0)
  })
  it('refuses to adopt or delete a resource owned by another configuration', async () => {
    await step()
    resources.get(row.provider_state.authorization).labels['boxlite-config'] = 'someone-else'
    await expect(step()).rejects.toMatchObject({ code: 'provider_resource_conflict' })
    row.deleted_at = new Date()
    await expect(step()).rejects.toMatchObject({ code: 'provider_resource_conflict' })
    expect(request.mock.calls.some(([call]) => call.method === 'DELETE')).toBe(false)
  })
  it('reports capacity independently of platform domain quota', async () => {
    request.mockRejectedValue({ response: { status: 429 } })
    await expect(step()).rejects.toMatchObject({ code: 'provider_capacity_exhausted' })
  })
  it('does not advance while a cloud operation remains pending', async () => {
    await step()
    request.mockResolvedValue({ data: { done: false } })
    request.mockClear()
    expect((await step()).expires).toBeNull()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('recovers a lost create response by reading the same resource identity', async () => {
    const cloud = request.getMockImplementation()!
    let lost = false
    request.mockImplementation(async (call) => {
      const result = await cloud(call)
      if (call.method === 'POST' && !lost) {
        lost = true
        throw new Error('connection reset after create')
      }
      return result
    })
    await expect(step()).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(row.provider_state).toEqual({})
    expect((await step()).state.authorizationRecord?.value).toBe('issued.authorize.certificatemanager.goog.')
    expect(request.mock.calls.filter(([call]) => call.method === 'POST')).toHaveLength(1)
  })

  it('refuses a stored operation outside the configured project', async () => {
    row.provider_state.operation = 'projects/another-project/locations/global/operations/foreign'
    await expect(step()).rejects.toMatchObject({ code: 'provider_resource_conflict' })
    expect(request).not.toHaveBeenCalled()
  })

  it('bounds a stalled cloud call without publishing readiness', async () => {
    jest.useFakeTimers()
    try {
      request.mockImplementation(() => new Promise(() => {}))
      const result = expect(step()).rejects.toMatchObject({ code: 'provider_unavailable' })
      await jest.advanceTimersByTimeAsync(10_000)
      await result
      expect(request.mock.calls[0][0].signal.aborted).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })
})
