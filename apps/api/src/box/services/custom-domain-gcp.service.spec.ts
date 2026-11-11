/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { CustomDomainGcpService } from './custom-domain-gcp.service'
import { CustomDomainRow } from './custom-domain-policy'

const request = jest.fn()
const verifyCertificate = jest.fn()
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
    provider = new CustomDomainGcpService(
      {
        getOrThrow: () => ({ project: 'test-project', certificateMap: 'proxy' }),
      } as never,
      { verifyCertificate, verify: jest.fn().mockResolvedValue(undefined) } as never,
    )
    verifyCertificate.mockReset().mockResolvedValue(undefined)
    resources = new Map()
    request.mockReset().mockImplementation(async ({ url, method, data }) => {
      if (url === 'https://cloudresourcemanager.googleapis.com/v1/projects/test-project')
        return { data: { projectId: 'test-project', projectNumber: '123456789' } }
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
          createTime: new Date().toISOString(),
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
  function canonicalResponses(includeOperations = false) {
    const cloud = request.getMockImplementation()!
    request.mockImplementation(async (call) => {
      const result = await cloud(call)
      const value = structuredClone(result.data)
      const canonical = (name: string) => name.replace('projects/test-project/', 'projects/123456789/')
      if (value.managed) value.managed.dnsAuthorizations = value.managed.dnsAuthorizations.map(canonical)
      if (value.certificates) value.certificates = value.certificates.map(canonical)
      if (includeOperations && value.name?.includes('/operations/')) value.name = canonical(value.name)
      return { data: value }
    })
  }

  it('prepares authorization records repeatedly without DNS checks or certificate creation', async () => {
    for (let i = 0; i < 4; i++) {
      const result = await provider.reconcile(row, 'prepare')
      row.provider_state = result.state
    }
    expect(row.provider_state.authorizationRecord?.type).toBe('CNAME')
    expect(resources.size).toBe(1)
    expect(verifyCertificate).not.toHaveBeenCalled()
    expect(request.mock.calls.filter(([call]) => call.method === 'POST')).toHaveLength(1)
  })

  it.each([400, 403, 429])(
    'marks a definite certificate POST rejection (%s) separately from an unknown result',
    async (status) => {
      await step()
      await step()
      const cloud = request.getMockImplementation()!
      request.mockImplementation((call) => {
        if (call.method === 'POST' && call.url.includes('/certificates?')) throw { response: { status } }
        return cloud(call)
      })
      await expect(step()).rejects.toMatchObject({ submissionRejected: true })
      expect(resources.size).toBe(1)
    },
  )

  it('does not create or replace resources while observing an already-issued certificate', async () => {
    for (let i = 0; i < 5; i++) await step()
    resources.get(row.provider_state.certificate).managed.state = 'FAILED'
    request.mockClear()
    verifyCertificate.mockClear()
    const observed = await provider.reconcile(row, 'observe')
    expect(observed.state.certificateState).toBe('FAILED')
    expect(request.mock.calls.every(([call]) => call.method === 'GET')).toBe(true)
    expect(verifyCertificate).not.toHaveBeenCalled()
  })

  it('accepts canonical numeric project references without changing the configured request project', async () => {
    canonicalResponses()
    for (let index = 0; index < 5; index++) await step()
    expect(row.phase).toBe('ready')
    const calls = request.mock.calls.map(([call]) => call.url as string)
    expect(calls.filter((url) => url.includes('cloudresourcemanager.googleapis.com'))).toEqual([
      'https://cloudresourcemanager.googleapis.com/v1/projects/test-project',
    ])
    expect(
      calls
        .filter((url) => url.includes('certificatemanager.googleapis.com'))
        .every((url) => url.startsWith(`https://certificatemanager.googleapis.com/v1/${parent}/`)),
    ).toBe(true)
  })

  it('cleans canonical numeric references in dependency order without checking DNS', async () => {
    for (let index = 0; index < 5; index++) await step()
    canonicalResponses()
    row.deleted_at = new Date()
    verifyCertificate.mockClear().mockRejectedValue(new Error('DNS removed'))
    for (let index = 0; index < 4; index++) await step()
    expect(resources.size).toBe(0)
    expect(verifyCertificate).not.toHaveBeenCalled()
  })

  it('polls numeric operation references within the configured project', async () => {
    canonicalResponses(true)
    for (let index = 0; index < 5; index++) await step()
    expect(row.phase).toBe('ready')
    expect(
      request.mock.calls
        .filter(([call]) => call.url.includes('certificatemanager.googleapis.com'))
        .every(([call]) => call.url.includes(`/v1/${parent}/`)),
    ).toBe(true)
  })

  it('checks the current certificate CNAME before requesting a certificate', async () => {
    await step()
    await step()
    const record = row.provider_state.authorizationRecord
    verifyCertificate.mockRejectedValue(Object.assign(new Error('missing CNAME'), { code: 'certificate_dns_mismatch' }))
    await expect(step()).rejects.toMatchObject({ code: 'certificate_dns_mismatch' })
    expect(verifyCertificate).toHaveBeenCalledWith(record, undefined)
    expect(resources.size).toBe(1)
  })

  it('publishes a changed authorization record before checking DNS or issuing a certificate', async () => {
    await step()
    await step()
    const authorization = resources.get(row.provider_state.authorization)
    authorization.dnsResourceRecord.name = '_acme-challenge_new.app.example.com.'
    authorization.dnsResourceRecord.data = 'new.authorize.certificatemanager.goog.'
    verifyCertificate.mockClear()
    const result = await step()
    expect(result.phase).toBe('pending_certificate_dns')
    expect(result.state.authorizationRecord?.value).toBe(authorization.dnsResourceRecord.data)
    expect(resources.size).toBe(1)
    expect(verifyCertificate).not.toHaveBeenCalled()
    await step()
    expect(verifyCertificate).toHaveBeenCalledWith(result.state.authorizationRecord, undefined)
    expect(resources.size).toBe(2)
  })

  it('replaces a stopped certificate in dependency order while retaining its DNS authorization', async () => {
    for (let index = 0; index < 5; index++) await step()
    row.phase = 'provisioning'
    const certificate = resources.get(row.provider_state.certificate)
    certificate.managed.state = 'FAILED'
    delete certificate.expireTime
    certificate.createTime = new Date(Date.now() - 3_600_000).toISOString()
    const authorization = resources.get(row.provider_state.authorization)
    const record = row.provider_state.authorizationRecord
    request.mockClear()
    for (let index = 0; index < 6; index++) await step()
    expect(row.phase).toBe('ready')
    expect(resources.get(row.provider_state.authorization)).toBe(authorization)
    expect(row.provider_state.authorizationRecord).toEqual(record)
    const deleted = request.mock.calls.filter(([call]) => call.method === 'DELETE').map(([call]) => call.url)
    expect(deleted).toEqual([
      `https://certificatemanager.googleapis.com/v1/${row.provider_state.entry}`,
      `https://certificatemanager.googleapis.com/v1/${row.provider_state.certificate}`,
    ])
  })

  it('reports certificate issuance after the certificate DNS check passes', async () => {
    await step()
    await step()
    expect((await step()).phase).toBe('provisioning')
  })

  it.each([
    { projectId: 'another-project', projectNumber: '123456789' },
    { projectId: 'test-project' },
    { projectId: 'test-project', projectNumber: '../other' },
    { projectId: 'test-project', projectNumber: 123456789 },
  ])('rejects an untrusted project mapping %j before touching certificate resources', async (mapping) => {
    request.mockResolvedValue({ data: mapping })
    await expect(step()).rejects.toMatchObject({ code: 'provider_invalid_response' })
    expect(request.mock.calls).toHaveLength(1)
    expect(request.mock.calls[0][0].url).toBe('https://cloudresourcemanager.googleapis.com/v1/projects/test-project')
  })

  it('retries project lookup after an IAM propagation failure', async () => {
    request.mockRejectedValueOnce({ response: { status: 403 } })
    await expect(step()).rejects.toMatchObject({ code: 'provider_permission_denied' })
    await step()
    expect(resources.size).toBe(1)
    expect(
      request.mock.calls.filter(([call]) => call.url.includes('cloudresourcemanager.googleapis.com')),
    ).toHaveLength(2)
  })

  it.each(['999999999', 'another-project'])(
    'refuses references to foreign project %s during adoption and cleanup',
    async (project) => {
      for (let index = 0; index < 5; index++) await step()
      const certificate = resources.get(row.provider_state.certificate)
      certificate.managed.dnsAuthorizations = [row.provider_state.authorization!.replace('test-project', project)]
      await expect(step()).rejects.toMatchObject({ code: 'provider_resource_conflict' })
      row.deleted_at = new Date()
      await step() // Remove the owned entry before reaching the conflicting certificate.
      request.mockClear()
      await expect(step()).rejects.toMatchObject({ code: 'provider_resource_conflict' })
      expect(request.mock.calls.some(([call]) => call.method === 'DELETE')).toBe(false)
    },
  )

  it('rejects a foreign numeric operation without requesting it', async () => {
    row.provider_state.operation = 'projects/999999999/locations/global/operations/foreign'
    await expect(step()).rejects.toMatchObject({ code: 'provider_resource_conflict' })
    expect(request.mock.calls.some(([call]) => call.url.includes('/operations/'))).toBe(false)
  })

  it.each(['projects/999999999/locations/global', 'projects/123456789/locations/us-central1'])(
    'rejects a map entry pointing outside %s',
    async (otherParent) => {
      for (let index = 0; index < 5; index++) await step()
      resources.get(row.provider_state.entry).certificates = [
        row.provider_state.certificate!.replace(parent, otherParent),
      ]
      await expect(step()).rejects.toMatchObject({ code: 'provider_resource_conflict' })
      row.deleted_at = new Date()
      request.mockClear()
      await expect(step()).rejects.toMatchObject({ code: 'provider_resource_conflict' })
      expect(request.mock.calls.some(([call]) => call.method === 'DELETE')).toBe(false)
    },
  )

  it('rejects a resource whose returned identity belongs to a different project', async () => {
    await step()
    resources.get(row.provider_state.authorization).name = row.provider_state.authorization!.replace(
      'test-project',
      '999999999',
    )
    await expect(step()).rejects.toMatchObject({ code: 'provider_resource_conflict' })
    row.deleted_at = new Date()
    await expect(step()).rejects.toMatchObject({ code: 'provider_resource_conflict' })
    expect(request.mock.calls.some(([call]) => call.method === 'DELETE')).toBe(false)
  })

  it.each(['recent', 'future', 'unexpired', 'invalid-time'])('retains a %s failed certificate', async (condition) => {
    for (let index = 0; index < 3; index++) await step()
    const certificate = resources.get(row.provider_state.certificate)
    certificate.managed.state = 'FAILED'
    if (condition !== 'unexpired') delete certificate.expireTime
    certificate.createTime =
      condition === 'invalid-time'
        ? 'invalid'
        : new Date(
            Date.now() + (condition === 'future' ? 60_000 : condition === 'unexpired' ? -7_200_000 : -3_599_000),
          ).toISOString()
    await expect(step()).rejects.toMatchObject({
      code: condition === 'invalid-time' ? 'provider_invalid_response' : 'certificate_provisioning_failed',
    })
    expect(request.mock.calls.some(([call]) => call.method === 'DELETE')).toBe(false)
  })

  it('retains an in-progress certificate despite a failed individual authorization attempt', async () => {
    for (let index = 0; index < 3; index++) await step()
    const certificate = resources.get(row.provider_state.certificate)
    certificate.managed.state = 'PROVISIONING'
    certificate.managed.authorizationAttemptInfo = [{ domain: row.hostname, state: 'FAILED', failureReason: 'CONFIG' }]
    expect(await step()).toMatchObject({ phase: 'provisioning', expires: null })
    expect(request.mock.calls.some(([call]) => call.method === 'DELETE')).toBe(false)
  })

  it('recovers a failed certificate when the delete response is lost', async () => {
    for (let index = 0; index < 3; index++) await step()
    const certificate = resources.get(row.provider_state.certificate)
    certificate.managed.state = 'FAILED'
    certificate.createTime = new Date(Date.now() - 7_200_000).toISOString()
    delete certificate.expireTime
    const cloud = request.getMockImplementation()!
    let lost = false
    request.mockImplementation(async (call) => {
      const result = await cloud(call)
      if (call.method === 'DELETE' && !lost) {
        lost = true
        throw new Error('connection reset after delete')
      }
      return result
    })
    await expect(step()).rejects.toMatchObject({ code: 'provider_unavailable' })
    for (let index = 0; index < 3; index++) await step()
    expect(row.phase).toBe('ready')
    expect(resources.size).toBe(3)
  })
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
    expect(
      request.mock.calls.every(
        ([call]) => call.url === 'https://cloudresourcemanager.googleapis.com/v1/projects/test-project',
      ),
    ).toBe(true)
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
