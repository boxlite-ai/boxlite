/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box } from '../entities/box.entity'
import {
  DOMAIN_COUNT_LIMIT_CODE,
  PLATFORM_DOMAIN_NOT_CONFIGURED_CODE,
  REGION_NOT_SUPPORTED_CODE,
  SUBDOMAIN_TAKEN_CODE,
  SUBDOMAIN_TOO_SHORT_CODE,
} from '../errors/domain.error'
import { DomainService } from './domain.service'

const ORG = '00000000-0000-4000-8000-000000000001'
const OTHER_ORG = '00000000-0000-4000-8000-000000000002'

function makeBox(): Box {
  const box = new Box('us', 'demo-box')
  box.organizationId = ORG
  return box
}

/**
 * The manager replays canned answers for the statements `bind` issues, in
 * order: lock, held lookup, count, upsert. Integration tests run the real
 * SQL; this pins the decisions between the statements.
 */
function makeService(
  options: {
    appDomain?: string
    minLength?: number
    limit?: number
    held?: { organizationId: string } | null
    used?: number
    regionProxyUrl?: string | null
    upsertRows?: number
  } = {},
) {
  const query = jest.fn()
  const manager = {
    query,
    findOne: jest.fn().mockResolvedValue(options.held ?? null),
    count: jest.fn().mockResolvedValue(options.used ?? 0),
  }
  query.mockImplementation((sql: string) => {
    if (sql.includes('SET LOCAL lock_timeout')) return Promise.resolve([])
    if (sql.includes('FOR UPDATE')) return Promise.resolve([{ limit: options.limit ?? 1 }])
    if (sql.includes('INSERT INTO "domain"')) {
      return Promise.resolve(Array.from({ length: options.upsertRows ?? 1 }, () => ({ id: 'domain-1' })))
    }
    return Promise.resolve([])
  })
  const dataSource = { transaction: jest.fn((work: (m: unknown) => Promise<unknown>) => work(manager)), query }
  const regionService = {
    findOne: jest
      .fn()
      .mockResolvedValue(options.regionProxyUrl === undefined ? null : { proxyUrl: options.regionProxyUrl }),
  }
  const config: Record<string, unknown> = {
    'domain.appDomain': 'appDomain' in options ? options.appDomain : 'app.boxlite.test',
    'domain.appHost': 'appDomain' in options ? options.appDomain : 'app.boxlite.test',
    'domain.platformSubdomainMinLength': options.minLength ?? 5,
    'proxy.domain': 'proxy.boxlite.test',
    'proxy.protocol': 'https',
  }
  const configService = {
    get: jest.fn((key: string) => config[key]),
    getOrThrow: jest.fn((key: string) => config[key]),
  }
  const service = new DomainService(dataSource as never, regionService as never, configService as never)
  return { service, manager, query }
}

describe('DomainService.parseSubdomain', () => {
  const { service } = makeService()

  it('lowercases a valid label', () => {
    expect(service.parseSubdomain(' Demo-App1 ')).toBe('demo-app1')
  })

  it.each(['', '-demo', 'demo-', 'de_mo', 'demo.app', 'a'.repeat(64), 'demo:443', 'https://demo'])(
    'rejects %j as malformed',
    (value) => {
      expect(() => service.parseSubdomain(value)).toThrow('Invalid subdomain')
    },
  )

  // `3000-abc.apps.example` would also parse as a legacy `<port>-<box>` host.
  it.each(['3000-abc', '1-x', 'www', 'api', 'proxy', 'boxes', 'volumes'])('rejects %s as reserved', (value) => {
    expect(() => service.parseSubdomain(value)).toThrow('reserved')
  })

  it('does not apply the minimum length: a held short name must stay bindable', () => {
    expect(service.parseSubdomain('ab')).toBe('ab')
  })
})

describe('DomainService.hostnameFor', () => {
  const { service } = makeService()

  it('reads a bare label and the full platform hostname as the same name', () => {
    for (const domain of ['demo1', 'Demo1', 'demo1.app.boxlite.test', 'DEMO1.App.Boxlite.Test.']) {
      expect(service.hostnameFor(domain, 'app.boxlite.test')).toBe('demo1.app.boxlite.test')
    }
  })

  it('refuses a hostname outside the app domain until custom domains exist', () => {
    expect(() => service.hostnameFor('api.example.com', 'app.boxlite.test')).toThrow('not under app.boxlite.test')
    expect(() => service.hostnameFor('app.boxlite.test.evil.com', 'app.boxlite.test')).toThrow('not under')
  })

  it('applies the label rules to the part before the app domain', () => {
    expect(() => service.hostnameFor('a.b.app.boxlite.test', 'app.boxlite.test')).toThrow('Invalid subdomain')
    expect(() => service.hostnameFor('boxes.app.boxlite.test', 'app.boxlite.test')).toThrow('reserved')
  })
})

describe('DomainService.bind', () => {
  it('refuses every name where the deployment has no app domain', async () => {
    const { service, query } = makeService({ appDomain: undefined })

    await expect(service.bind(makeBox(), 3000, 'demo1')).rejects.toMatchObject({
      status: 400,
      response: { code: PLATFORM_DOMAIN_NOT_CONFIGURED_CODE },
    })
    expect(query).not.toHaveBeenCalled()
  })

  it('refuses a box whose region has a proxy of its own, before any write', async () => {
    const { service, query } = makeService({ regionProxyUrl: 'https://proxy.eu.boxlite.test' })

    await expect(service.bind(makeBox(), 3000, 'demo1')).rejects.toMatchObject({
      status: 400,
      response: { code: REGION_NOT_SUPPORTED_CODE },
    })
    expect(query).not.toHaveBeenCalled()
  })

  it('accepts a region whose proxy is the platform proxy, whatever its case', async () => {
    const { service } = makeService({ regionProxyUrl: 'https://Proxy.BoxLite.test' })

    await expect(service.bind(makeBox(), 3000, 'demo1')).resolves.toMatchObject({
      url: 'https://demo1.app.boxlite.test',
    })
  })

  it('upserts the box port as the target under the organization lock, without declaring the port', async () => {
    const { service, query } = makeService()
    const box = makeBox()

    await expect(service.bind(box, 3000, 'Demo1')).resolves.toEqual({
      name: 'demo1',
      hostname: 'demo1.app.boxlite.test',
      url: 'https://demo1.app.boxlite.test',
      boxId: box.id,
      port: 3000,
    })

    const statements = query.mock.calls.map(([sql]) => sql as string)
    expect(statements).toHaveLength(3)
    expect(statements[0]).toContain('SET LOCAL lock_timeout')
    expect(statements[1]).toContain('FOR UPDATE')
    expect(statements[2]).toContain('INSERT INTO "domain"')
    expect(query.mock.calls[2][1]).toEqual(['demo1.app.boxlite.test', ORG, box.id, 3000])
  })

  it('refuses a new name shorter than the minimum, but not a held one', async () => {
    const fresh = makeService({ minLength: 5 })
    await expect(fresh.service.bind(makeBox(), 3000, 'demo')).rejects.toMatchObject({
      status: 400,
      response: { code: SUBDOMAIN_TOO_SHORT_CODE },
    })

    const held = makeService({ minLength: 5, held: { organizationId: ORG } })
    await expect(held.service.bind(makeBox(), 3000, 'demo')).resolves.toMatchObject({
      url: 'https://demo.app.boxlite.test',
    })
  })

  it('refuses a new name once the organization holds its limit, and lets a held name through', async () => {
    const full = makeService({ limit: 1, used: 1 })
    await expect(full.service.bind(makeBox(), 3000, 'demo1')).rejects.toMatchObject({
      status: 400,
      response: { code: DOMAIN_COUNT_LIMIT_CODE },
    })
    expect(full.query.mock.calls.some(([sql]) => (sql as string).includes('INSERT INTO'))).toBe(false)

    const reuse = makeService({ limit: 1, used: 1, held: { organizationId: ORG } })
    await expect(reuse.service.bind(makeBox(), 3000, 'demo1')).resolves.toMatchObject({
      url: 'https://demo1.app.boxlite.test',
    })
  })

  it('refuses a name another organization holds, bound or not', async () => {
    const { service } = makeService({ held: { organizationId: OTHER_ORG } })

    await expect(service.bind(makeBox(), 3000, 'demo1')).rejects.toMatchObject({
      status: 409,
      response: { code: SUBDOMAIN_TAKEN_CODE },
    })
  })

  it("moves a held name to the new target and leaves the port's other names alone", async () => {
    const { service, query } = makeService({ held: { organizationId: ORG } })

    await expect(service.bind(makeBox(), 3000, 'demo1')).resolves.toMatchObject({ port: 3000 })

    const statements = query.mock.calls.map(([sql]) => sql as string)
    const upsert = statements.find((sql) => sql.includes('INSERT INTO "domain"'))
    expect(upsert).toContain('SET "box_id" = EXCLUDED."box_id", "port" = EXCLUDED."port"')
    expect(statements.some((sql) => sql.startsWith('UPDATE'))).toBe(false)
  })

  it('treats an upsert that bound nothing as a lost race for the name', async () => {
    const { service } = makeService({ upsertRows: 0 })

    await expect(service.bind(makeBox(), 3000, 'demo1')).rejects.toMatchObject({ status: 409 })
  })
})

describe('DomainService.resolve', () => {
  it('returns the stored target with a numeric port and a normalized hostname', async () => {
    const { service, query } = makeService()
    query.mockResolvedValue([{ boxId: 'AbCdEf123456', port: '3000' }])

    await expect(service.resolve('Demo1.App.BoxLite.test')).resolves.toEqual({ boxId: 'AbCdEf123456', port: 3000 })
    expect(query).toHaveBeenCalledWith(expect.any(String), ['demo1.app.boxlite.test'])
  })

  it('returns null for an unknown or unbound name', async () => {
    const { service, query } = makeService()
    query.mockResolvedValue([])

    await expect(service.resolve('nobody.app.boxlite.test')).resolves.toBeNull()
  })
})
