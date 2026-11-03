/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box } from '../entities/box.entity'
import {
  DOMAIN_COUNT_LIMIT_CODE,
  DOMAIN_NOT_OWNED_CODE,
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
 * The manager replays canned answers for the statements `claim` issues, in
 * order: lock, held lookup, count, insert. Integration tests run the real
 * SQL; this pins the decisions between the statements.
 */
function makeService(
  options: {
    appDomain?: string
    minLength?: number
    limit?: number
    held?: {
      organizationId: string
      targetType?: string
      boxId?: string | null
      appId?: string | null
      port?: number | null
    } | null
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
    if (sql.startsWith('UPDATE "domain"')) return Promise.resolve([[], options.upsertRows ?? 1])
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

describe('DomainService.claim', () => {
  it('requests a short name and returns an unbound full hostname', async () => {
    const { service, query } = makeService()
    await expect(service.claim(ORG, ' Demo1 ')).resolves.toEqual({
      hostname: 'demo1.app.boxlite.test',
      url: 'https://demo1.app.boxlite.test',
      target: null,
    })
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('DO NOTHING'), ['demo1.app.boxlite.test', ORG])
  })

  it('refuses claims when the platform domain is not configured', async () => {
    const { service, query } = makeService({ appDomain: undefined })
    await expect(service.claim(ORG, 'demo1')).rejects.toMatchObject({
      status: 400,
      response: { code: PLATFORM_DOMAIN_NOT_CONFIGURED_CODE },
    })
    expect(query).not.toHaveBeenCalled()
  })

  it('requires a short name rather than a full hostname', async () => {
    await expect(makeService().service.claim(ORG, 'demo1.app.boxlite.test')).rejects.toMatchObject({ status: 400 })
  })

  it('applies minimum length and quota only to new claims', async () => {
    await expect(makeService().service.claim(ORG, 'demo')).rejects.toMatchObject({
      response: { code: SUBDOMAIN_TOO_SHORT_CODE },
    })
    await expect(makeService({ used: 1 }).service.claim(ORG, 'demo1')).rejects.toMatchObject({
      response: { code: DOMAIN_COUNT_LIMIT_CODE },
    })
    const { service, manager } = makeService({
      used: 1,
      minLength: 10,
      held: { organizationId: ORG, targetType: 'box', boxId: 'mybox', appId: null, port: 3000 },
    })
    await expect(service.claim(ORG, 'demo1')).resolves.toMatchObject({
      target: { type: 'box', box: 'mybox', port: 3000 },
    })
    expect(manager.count).not.toHaveBeenCalled()
  })

  it('refuses a foreign claim and a lost cross-organization race', async () => {
    for (const options of [{ held: { organizationId: OTHER_ORG } }, { upsertRows: 0 }]) {
      await expect(makeService(options).service.claim(ORG, 'demo1')).rejects.toMatchObject({
        status: 409,
        response: { code: SUBDOMAIN_TAKEN_CODE },
      })
    }
  })
})

describe('DomainService.bind', () => {
  it('rejects short bind and unbind inputs before any write', async () => {
    const { service, query } = makeService()
    await expect(service.bind(makeBox(), 3000, 'demo1')).rejects.toMatchObject({ status: 400 })
    await expect(service.unbind(ORG, 'demo1')).rejects.toMatchObject({ status: 400 })
    expect(query).not.toHaveBeenCalled()
  })

  it('refuses a box with its own regional proxy before writing', async () => {
    const { service, query } = makeService({ regionProxyUrl: 'https://proxy.eu.boxlite.test' })
    await expect(service.bind(makeBox(), 3000, 'demo1.app.boxlite.test')).rejects.toMatchObject({
      status: 400,
      response: { code: REGION_NOT_SUPPORTED_CODE },
    })
    expect(query).not.toHaveBeenCalled()
  })

  it('updates only an owned full hostname, without inserting or applying claim rules', async () => {
    const { service, query, manager } = makeService({
      appDomain: undefined,
      used: 1,
      minLength: 10,
      regionProxyUrl: 'https://Proxy.BoxLite.test',
    })
    const box = makeBox()
    await expect(service.bind(box, 3000, ' DEMO1.Other.Example. ')).resolves.toEqual({
      hostname: 'demo1.other.example',
      url: 'https://demo1.other.example',
      target: { type: 'box', box: box.id, port: 3000 },
    })
    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE "hostname" = $1 AND "organization_id" = $2'), [
      'demo1.other.example',
      ORG,
      box.id,
      3000,
    ])
    expect(query.mock.calls[0][0]).toMatch(/^UPDATE/)
    expect(manager.count).not.toHaveBeenCalled()
  })

  it('directs missing or foreign owners to Dashboard without inserting', async () => {
    const { service, query } = makeService({ upsertRows: 0 })
    await expect(service.bind(makeBox(), 3000, 'demo1.app.boxlite.test')).rejects.toMatchObject({
      status: 404,
      response: { code: DOMAIN_NOT_OWNED_CODE, message: expect.stringContaining('Dashboard > Domains') },
    })
    expect(query).toHaveBeenCalledTimes(1)
  })
})

describe('DomainService.resolve', () => {
  it('returns the stored target with a numeric port and a normalized hostname', async () => {
    const { service, query } = makeService()
    query.mockResolvedValue([{ targetType: 'box', boxId: 'AbCdEf123456', appId: null, port: '3000' }])

    await expect(service.resolve('Demo1.App.BoxLite.test')).resolves.toEqual({
      type: 'box',
      box: 'AbCdEf123456',
      port: 3000,
    })
    expect(query).toHaveBeenCalledWith(expect.any(String), ['demo1.app.boxlite.test'])
  })

  it('returns null for an unknown or unbound name', async () => {
    const { service, query } = makeService()
    query.mockResolvedValue([])

    await expect(service.resolve('nobody.app.boxlite.test')).resolves.toBeNull()
  })
})
