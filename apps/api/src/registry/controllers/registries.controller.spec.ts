/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Reflector } from '@nestjs/core'
import { AUDIT_CONTEXT_KEY, AuditContext } from '../../audit/decorators/audit.decorator'
import { RequiredOrganizationResourcePermissions } from '../../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../../organization/enums/organization-resource-permission.enum'
import { RegistriesController } from './registries.controller'

const reflector = new Reflector()
const route = (name: keyof RegistriesController) => RegistriesController.prototype[name]

describe('RegistriesController', () => {
  it.each([
    ['list', OrganizationResourcePermission.READ_REGISTRIES],
    ['create', OrganizationResourcePermission.WRITE_REGISTRIES],
    ['delete', OrganizationResourcePermission.DELETE_REGISTRIES],
  ] as const)('requires exactly its own scope on %s', (name, scope) => {
    // The guard reads this and nothing else, so a route with the wrong scope
    // here is a route anyone holding that other scope can call.
    expect(reflector.get(RequiredOrganizationResourcePermissions, route(name))).toEqual([scope])
  })

  it('keeps the password out of what the audit log records for a create', () => {
    const audit = reflector.get<AuditContext>(AUDIT_CONTEXT_KEY, route('create'))
    const recorded = audit.requestMetadata?.body?.({
      body: { registryHost: 'ghcr.io', repositoryPrefix: 'acme/', username: 'acme-bot', password: 'ghp_x' },
    } as never)

    expect(recorded).toEqual({ registryHost: 'ghcr.io', repositoryPrefix: 'acme/', username: 'acme-bot' })
    expect(JSON.stringify(recorded)).not.toContain('ghp_x')
  })
})
