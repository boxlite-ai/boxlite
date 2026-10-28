/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpStatus, RequestMethod, ValidationPipe } from '@nestjs/common'
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { Reflector } from '@nestjs/core'
import { readdirSync, readFileSync } from 'node:fs'
import { BoxliteDomainController } from './boxlite-domain.controller'
import { DomainTargetDto } from './dto/domain-target.dto'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { REST_COLLECTION_NAMES, RESERVED_PLATFORM_SUBDOMAINS } from '../box/services/domain.service'

const auth = { organizationId: 'org-1', organization: { id: 'org-1' } }

function makeHarness() {
  const domainService = {
    listHeld: jest.fn().mockResolvedValue({
      domains: [
        {
          name: 'demo1',
          hostname: 'demo1.app.test',
          url: 'https://demo1.app.test',
          boxId: 'AbCdEf123456',
          port: 3000,
        },
        { name: 'spare', hostname: 'spare.app.test', url: 'https://spare.app.test', boxId: null, port: null },
      ],
      limit: 2,
      used: 2,
      remaining: 0,
      minLength: 5,
    }),
    bind: jest.fn().mockResolvedValue({
      name: 'demo1',
      hostname: 'demo1.app.test',
      url: 'https://demo1.app.test',
      boxId: 'box-uuid',
      port: 3000,
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
  it('mounts under the organization, not a box, at canonical and legacy prefixes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, BoxliteDomainController)).toEqual(['v1/domains', 'v1/:prefix/domains'])
  })

  // `/v1/domains/<name>/target` has the shape of `v1/:prefix/<collection>/:id`,
  // so a name equal to a collection would reach that collection's route too.
  // Read from source: importing every controller pulls ESM-only dependencies.
  it('reserves every collection mounted under v1/:prefix as a name', () => {
    const collections = new Set<string>()
    for (const file of readdirSync(__dirname).filter((name) => name.endsWith('.controller.ts'))) {
      for (const [, collection] of readFileSync(`${__dirname}/${file}`, 'utf8').matchAll(/'v1\/:prefix\/([^/':]+)/g)) {
        collections.add(collection)
      }
    }
    expect([...collections].sort()).toEqual([...REST_COLLECTION_NAMES].sort())
    for (const collection of collections) {
      expect(RESERVED_PLATFORM_SUBDOMAINS.has(collection)).toBe(true)
    }
  })

  it('lists held names in the REST shape, unbound ones with a null target, under box write permission', async () => {
    const { controller } = makeHarness()
    const reflector = new Reflector()
    expect(reflector.get(RequiredOrganizationResourcePermissions, BoxliteDomainController.prototype.list)).toEqual([
      OrganizationResourcePermission.WRITE_BOXES,
    ])

    await expect(controller.list(auth as never)).resolves.toEqual({
      domains: [
        {
          name: 'demo1',
          hostname: 'demo1.app.test',
          url: 'https://demo1.app.test',
          target: { type: 'box', box: 'AbCdEf123456', port: 3000 },
        },
        { name: 'spare', hostname: 'spare.app.test', url: 'https://spare.app.test', target: null },
      ],
      limit: 2,
      used: 2,
      remaining: 0,
      min_length: 5,
    })
  })

  it('binds with PUT on the target, resolving the box by id or name in the organization', async () => {
    const { controller, domainService, boxService } = makeHarness()
    const handler = BoxliteDomainController.prototype.bind
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.PUT)
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':domain/target')
    expect(new Reflector().get(RequiredOrganizationResourcePermissions, handler)).toEqual([
      OrganizationResourcePermission.WRITE_BOXES,
    ])

    const result = await controller.bind(auth as never, 'demo1', { type: 'box', box: 'web-a', port: 3000 })

    expect(boxService.findOneByIdOrName).toHaveBeenCalledWith('web-a', 'org-1')
    expect(domainService.bind).toHaveBeenCalledWith(expect.objectContaining({ id: 'box-uuid' }), 3000, 'demo1')
    expect(result).toEqual({
      name: 'demo1',
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

    await controller.bind(auth as never, 'demo1', { type: 'box', box: 'web-a', port: 3000 })

    expect(domainService.bind).toHaveBeenCalledWith(expect.objectContaining({ id: 'box-uuid' }), 3000, 'demo1')
  })

  it('accepts a box target and rejects a target whose type and fields disagree', async () => {
    await expect(validateTarget({ type: 'box', box: 'web-a', port: 3000 })).resolves.toBeInstanceOf(DomainTargetDto)
    for (const body of [
      { type: 'app', app: 'shop' },
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
    expect(new Reflector().get(RequiredOrganizationResourcePermissions, handler)).toEqual([
      OrganizationResourcePermission.WRITE_BOXES,
    ])

    await controller.unbind(auth as never, 'demo1.app.test')

    expect(domainService.unbind).toHaveBeenCalledWith('org-1', 'demo1.app.test')
  })
})
