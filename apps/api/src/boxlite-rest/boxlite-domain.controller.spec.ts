/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpStatus, RequestMethod, ValidationPipe } from '@nestjs/common'
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { readdirSync, readFileSync } from 'node:fs'
import { BoxliteDomainController } from './boxlite-domain.controller'
import { ClaimDomainDto } from './dto/claim-domain.dto'
import { DomainTargetDto } from './dto/domain-target.dto'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { REST_COLLECTION_NAMES, RESERVED_PLATFORM_SUBDOMAINS } from '../box/services/domain.service'

const auth = { organizationId: 'org-1', organization: { id: 'org-1' }, role: 'admin' }
const member = (...permissions: OrganizationResourcePermission[]) => ({
  ...auth,
  role: 'user',
  organizationUser: { role: 'member', assignedRoles: [{ permissions }] },
})

function makeHarness() {
  const domainService = {
    listHeld: jest.fn().mockResolvedValue({
      domains: [
        {
          hostname: 'demo1.app.test',
          url: 'https://demo1.app.test',
          target: { type: 'box', box: 'AbCdEf123456', port: 3000 },
        },
        { hostname: 'spare.app.test', url: 'https://spare.app.test', target: null },
      ],
      limit: 2,
      used: 2,
      remaining: 0,
      minLength: 5,
      domainSuffix: 'app.test',
    }),
    claim: jest.fn().mockResolvedValue({ hostname: 'demo1.app.test', url: 'https://demo1.app.test', target: null }),
    bind: jest.fn().mockResolvedValue({
      hostname: 'demo1.app.test',
      url: 'https://demo1.app.test',
      target: { type: 'box', box: 'box-uuid', port: 3000 },
    }),
    owned: jest.fn().mockResolvedValue({ hostname: 'demo1.app.test', url: 'https://demo1.app.test', target: null }),
    bindApp: jest
      .fn()
      .mockResolvedValue({
        hostname: 'demo1.app.test',
        url: 'https://demo1.app.test',
        target: { type: 'app', app: 'app-shop', environment: 'env-main' },
      }),
    unbind: jest.fn().mockResolvedValue(undefined),
  }
  const boxService = {
    findOneByIdOrName: jest.fn().mockResolvedValue({ id: 'box-uuid', inboundEnabled: true }),
  }
  const controller = new BoxliteDomainController(domainService as never, boxService as never)
  return { controller, domainService, boxService }
}

function validateTarget(body: unknown) {
  return new ValidationPipe({ transform: true }).transform(body, { type: 'body', metatype: DomainTargetDto })
}

describe('BoxliteDomainController', () => {
  it('hostname contract: list omits short names from the public response', async () => {
    const { controller } = makeHarness()
    const result = await controller.list(auth as never)
    for (const domain of result.domains) {
      expect(domain).not.toHaveProperty('name')
      expect(domain.hostname).toContain('.')
    }
  })

  it('binds an App in its main environment without a Box lookup', async () => {
    const { controller, boxService, domainService } = makeHarness()
    await expect(
      controller.bind(member(OrganizationResourcePermission.WRITE_APPS) as never, 'demo1.app.test', {
        type: 'app',
        app: 'shop',
      }),
    ).resolves.toMatchObject({ target: { type: 'app', environment: 'env-main' } })
    expect(domainService.bindApp).toHaveBeenCalledWith('org-1', 'shop', 'main', 'demo1.app.test')
    expect(boxService.findOneByIdOrName).not.toHaveBeenCalled()
    expect(domainService.bind).not.toHaveBeenCalled()
  })

  it('mounts under the organization, not a box, at canonical and legacy prefixes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, BoxliteDomainController)).toEqual(['v1/domains', 'v1/:prefix/domains'])
  })

  // Keep the platform's reserved-label policy aligned with its REST collections.
  // Read from source: importing every controller pulls ESM-only dependencies.
  it('reserves every collection mounted under v1/:prefix as a name', () => {
    const collections = new Set<string>()
    for (const directory of [__dirname, `${__dirname}/../cloud-app`]) {
      for (const file of readdirSync(directory).filter((name) => name.endsWith('.controller.ts'))) {
        const source = readFileSync(`${directory}/${file}`, 'utf8')
        for (const [, collection] of source.matchAll(/'v1\/:(?:prefix|organizationId|orgId)\/([^/':]+)/g))
          collections.add(collection)
        if (/@Controller\('v1\/:(?:prefix|organizationId|orgId)'\)/.test(source)) {
          for (const [, collection] of source.matchAll(/@All\(\['([^/':]+)',/g)) collections.add(collection)
        }
      }
    }
    expect([...collections].sort()).toEqual([...REST_COLLECTION_NAMES].sort())
    for (const collection of collections) {
      expect(RESERVED_PLATFORM_SUBDOMAINS.has(collection)).toBe(true)
    }
  })

  it('lists held names in the REST shape with a null target while unbound', async () => {
    const { controller } = makeHarness()
    await expect(controller.list(auth as never)).resolves.toEqual({
      domains: [
        {
          hostname: 'demo1.app.test',
          url: 'https://demo1.app.test',
          target: { type: 'box', box: 'AbCdEf123456', port: 3000 },
        },
        { hostname: 'spare.app.test', url: 'https://spare.app.test', target: null },
      ],
      limit: 2,
      used: 2,
      remaining: 0,
      min_length: 5,
      domain_suffix: 'app.test',
    })
  })

  it('claims a short name for the authenticated organization with POST and write permission', async () => {
    const { controller, domainService, boxService } = makeHarness()
    const handler = BoxliteDomainController.prototype.claim
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST)
    await expect(controller.claim(auth as never, { name: 'demo1' })).resolves.toMatchObject({
      hostname: 'demo1.app.test',
      target: null,
    })
    expect(domainService.claim).toHaveBeenCalledWith('org-1', 'demo1')
    expect(boxService.findOneByIdOrName).not.toHaveBeenCalled()
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })
    for (const body of [
      {},
      { name: 42 },
      { name: '' },
      { name: 'a'.repeat(64) },
      { name: 'demo1', organizationId: 'other' },
    ]) {
      await expect(pipe.transform(body, { type: 'body', metatype: ClaimDomainDto })).rejects.toMatchObject({
        status: 400,
      })
    }
  })

  it('binds with PUT on the target, resolving the box by id or name in the organization', async () => {
    const { controller, domainService, boxService } = makeHarness()
    const handler = BoxliteDomainController.prototype.bind
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.PUT)
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':domain/target')

    const result = await controller.bind(auth as never, 'demo1.app.test', { type: 'box', box: 'web-a', port: 3000 })

    expect(boxService.findOneByIdOrName).toHaveBeenCalledWith('web-a', 'org-1')
    expect(domainService.bind).toHaveBeenCalledWith(expect.objectContaining({ id: 'box-uuid' }), 3000, 'demo1.app.test')
    expect(result).toEqual({
      hostname: 'demo1.app.test',
      url: 'https://demo1.app.test',
      target: { type: 'box', box: 'box-uuid', port: 3000 },
    })
  })

  // Inbound access is checked on every request to the name, like the port's
  // own URL; binding only records the target, so it can come first.
  it('binds to a box whose inbound access is still disabled', async () => {
    const { controller, domainService, boxService } = makeHarness()
    boxService.findOneByIdOrName.mockResolvedValue({ id: 'box-uuid', inboundEnabled: false })

    await controller.bind(auth as never, 'demo1.app.test', { type: 'box', box: 'web-a', port: 3000 })

    expect(domainService.bind).toHaveBeenCalledWith(expect.objectContaining({ id: 'box-uuid' }), 3000, 'demo1.app.test')
  })

  it('accepts a box target and rejects a target whose type and fields disagree', async () => {
    await expect(validateTarget({ type: 'box', box: 'web-a', port: 3000 })).resolves.toBeInstanceOf(DomainTargetDto)
    for (const body of [
      { type: 'unknown', app: 'shop' },
      { type: 'box', box: 'web-a' },
      { type: 'box', port: 3000 },
      { box: 'web-a', port: 3000 },
      { type: 'box', box: 'web-a', port: 0 },
      { type: 'box', box: '', port: 3000 },
    ]) {
      await expect(validateTarget(body)).rejects.toMatchObject({ status: 400 })
    }
  })

  it('unbinds by name for the calling organization with DELETE on the target, answering 204', async () => {
    const { controller, domainService } = makeHarness()
    const handler = BoxliteDomainController.prototype.unbind
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.DELETE)
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':domain/target')
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(HttpStatus.NO_CONTENT)

    await controller.unbind(auth as never, 'demo1.app.test')

    expect(domainService.unbind).toHaveBeenCalledWith('org-1', 'demo1.app.test')
  })
  it('uses the target kind for write permission, including a binding being replaced', async () => {
    const { controller, domainService, boxService } = makeHarness()
    const appWriter = member(OrganizationResourcePermission.WRITE_APPS)
    const boxWriter = member(OrganizationResourcePermission.WRITE_BOXES)
    await expect(
      controller.bind(boxWriter as never, 'demo1.app.test', { type: 'app', app: 'shop' }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      controller.bind(appWriter as never, 'demo1.app.test', { type: 'box', box: 'web', port: 3000 }),
    ).rejects.toMatchObject({ status: 403 })
    domainService.owned.mockResolvedValue({ target: { type: 'box', box: 'web', port: 3000 } })
    await expect(
      controller.bind(appWriter as never, 'demo1.app.test', { type: 'app', app: 'shop' }),
    ).rejects.toMatchObject({ status: 403 })
    expect(domainService.bindApp).not.toHaveBeenCalled()
    expect(boxService.findOneByIdOrName).not.toHaveBeenCalled()
  })

  it('allows App reads but keeps claims and unbinding behind their write permissions', async () => {
    const { controller, domainService } = makeHarness()
    await expect(controller.list(member(OrganizationResourcePermission.READ_APPS) as never)).resolves.toHaveProperty(
      'domains',
    )
    await expect(
      controller.claim(member(OrganizationResourcePermission.READ_APPS) as never, { name: 'demo1' }),
    ).rejects.toMatchObject({ status: 403 })
    domainService.owned.mockResolvedValue({ target: { type: 'app', app: 'app-shop', environment: 'env-main' } })
    await expect(
      controller.unbind(member(OrganizationResourcePermission.WRITE_BOXES) as never, 'demo1.app.test'),
    ).rejects.toMatchObject({ status: 403 })
    await controller.unbind(member(OrganizationResourcePermission.WRITE_APPS) as never, 'demo1.app.test')
    expect(domainService.unbind).toHaveBeenCalledTimes(1)
    expect(domainService.claim).not.toHaveBeenCalled()
  })

  it('keeps App-scoped keys out of organization-wide domain operations', async () => {
    const { controller, domainService } = makeHarness()
    const scoped = {
      ...member(OrganizationResourcePermission.WRITE_APPS),
      apiKey: { cloudAppId: 'shop', permissions: [OrganizationResourcePermission.WRITE_APPS] },
    }
    await expect(controller.claim(scoped as never, { name: 'demo1' })).rejects.toMatchObject({ status: 403 })
    await expect(controller.list(scoped as never)).rejects.toMatchObject({ status: 403 })
    expect(domainService.claim).not.toHaveBeenCalled()
    expect(domainService.listHeld).not.toHaveBeenCalled()
  })

  it('validates App environment selection and refuses mixed target fields', async () => {
    await expect(validateTarget({ type: 'app', app: 'shop', environment: 'staging' })).resolves.toBeInstanceOf(
      DomainTargetDto,
    )
    await expect(validateTarget({ type: 'app', app: 'shop', environment: '' })).rejects.toMatchObject({ status: 400 })
    const { controller, domainService } = makeHarness()
    await expect(
      controller.bind(auth as never, 'demo1.app.test', { type: 'app', app: 'shop', box: 'web', port: 3000 }),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      controller.bind(auth as never, 'demo1.app.test', { type: 'box', box: 'web', port: 3000, environment: 'staging' }),
    ).rejects.toMatchObject({ status: 400 })
    expect(domainService.bind).not.toHaveBeenCalled()
    expect(domainService.bindApp).not.toHaveBeenCalled()
  })
})
