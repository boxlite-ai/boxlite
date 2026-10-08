/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { PATH_METADATA } from '@nestjs/common/constants'
import { Reflector } from '@nestjs/core'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { AUDIT_CONTEXT_KEY, AuditContext } from '../audit/decorators/audit.decorator'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { RegistriesService } from '../registry/services/registries.service'
import { BoxliteRegistryController } from './boxlite-registry.controller'
import { CreateRegistryDto } from './dto/create-registry.dto'

const reflector = new Reflector()
const route = (name: keyof BoxliteRegistryController) => BoxliteRegistryController.prototype[name]
const PASSWORD = 'ghp_not-a-real-token'
const BODY = { registry_host: 'ghcr.io', repository_prefix: 'acme/', username: 'acme-bot', password: PASSWORD }

describe('BoxliteRegistryController', () => {
  const createdAt = new Date('2026-09-01T00:00:00.000Z')
  const caller = { organizationId: 'org-1', userId: 'user-1' } as never
  // A row as the repository holds it, with the fields an answer must not carry.
  const row = {
    id: '0aaa0000-0000-4000-8000-000000000001',
    organizationId: 'org-1',
    kind: 'basic',
    registryHost: 'ghcr.io',
    repositoryPrefix: 'acme/',
    username: 'acme-bot',
    secretVersion: 'projects/p/secrets/s/versions/1',
    createdBy: 'user-1',
    createdAt,
  }
  const answered = {
    id: row.id,
    registry_host: 'ghcr.io',
    repository_prefix: 'acme/',
    username: 'acme-bot',
    created_by: 'user-1',
    created_at: createdAt.toISOString(),
  }

  function createController() {
    const registries = {
      list: jest.fn().mockResolvedValue([row]),
      create: jest.fn().mockResolvedValue(row),
      delete: jest.fn().mockResolvedValue(undefined),
    }
    return {
      controller: new BoxliteRegistryController(registries as unknown as RegistriesService),
      registries,
    }
  }

  it('is mounted with and without a routing prefix, like the other box API routes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, BoxliteRegistryController)).toEqual([
      'v1/registries',
      'v1/:prefix/registries',
    ])
  })

  it.each([
    ['list', OrganizationResourcePermission.READ_REGISTRIES],
    ['create', OrganizationResourcePermission.WRITE_REGISTRIES],
    ['remove', OrganizationResourcePermission.DELETE_REGISTRIES],
  ] as const)('requires exactly its own scope on %s, as the console routes do', (name, scope) => {
    expect(reflector.get(RequiredOrganizationResourcePermissions, route(name))).toEqual([scope])
  })

  it("lists the organization's logins in the box API shape, without where the password is kept", async () => {
    const { controller, registries } = createController()

    await expect(controller.list(caller)).resolves.toEqual({ registries: [answered] })
    expect(registries.list).toHaveBeenCalledWith('org-1')
  })

  it('hands the login to the console service under its own names, and answers without the password', async () => {
    const { controller, registries } = createController()

    const created = await controller.create(caller, plainToInstance(CreateRegistryDto, BODY))

    expect(registries.create).toHaveBeenCalledWith('org-1', 'user-1', {
      registryHost: 'ghcr.io',
      repositoryPrefix: 'acme/',
      username: 'acme-bot',
      password: PASSWORD,
    })
    expect(created).toEqual(answered)
  })

  it('removes a login of the caller organization by id', async () => {
    const { controller, registries } = createController()

    await controller.remove(caller, row.id)

    expect(registries.delete).toHaveBeenCalledWith('org-1', row.id)
  })

  it('keeps the password out of what the audit log records for a create', () => {
    const audit = reflector.get<AuditContext>(AUDIT_CONTEXT_KEY, route('create'))
    const recorded = audit.requestMetadata?.body?.({ body: BODY } as never)

    expect(recorded).toEqual({ registry_host: 'ghcr.io', repository_prefix: 'acme/', username: 'acme-bot' })
    expect(JSON.stringify(recorded)).not.toContain(PASSWORD)
  })

  describe('CreateRegistryDto', () => {
    async function refusals(body: Record<string, unknown>): Promise<string[]> {
      const errors = await validate(plainToInstance(CreateRegistryDto, body))
      return errors.flatMap((error) => Object.values(error.constraints ?? {}))
    }

    it('takes a login in snake_case, with or without a prefix', async () => {
      expect(await refusals(BODY)).toEqual([])
      expect(await refusals({ ...BODY, repository_prefix: undefined })).toEqual([])
    })

    it.each([
      ['a registry no login is taken for', { registry_host: 'registry.example.com' }, 'registry_host'],
      ['a prefix that is not whole path segments', { repository_prefix: 'acme' }, 'repository_prefix'],
      ['no username', { username: '' }, 'username'],
      ['no password', { password: '' }, 'password'],
    ])('refuses %s, naming the field', async (_, change, field) => {
      const messages = await refusals({ ...BODY, ...change })

      expect(messages.length).toBeGreaterThan(0)
      expect(messages.every((message) => message.includes(field))).toBe(true)
    })

    it('never repeats the password in a refusal', async () => {
      const tooLong = 'x'.repeat(8193)

      const messages = await refusals({ ...BODY, password: tooLong })

      expect(messages.length).toBeGreaterThan(0)
      expect(messages.join(' ')).not.toContain(tooLong)
    })
  })
})
