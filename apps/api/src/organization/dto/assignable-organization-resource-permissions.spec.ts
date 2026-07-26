/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { CreateApiKeyDto } from '../../api-key/dto/create-api-key.dto'
import { CreateOrganizationRoleDto } from './create-organization-role.dto'
import { UpdateOrganizationRoleDto } from './update-organization-role.dto'

const supportedPermissions = ['write:boxes', 'delete:boxes']

const unsupportedPermissions = [
  'write:registries',
  'delete:registries',
  'write:templates',
  'delete:templates',
  'write:regions',
  'delete:regions',
  'read:runners',
  'write:runners',
  'delete:runners',
  'read:volumes',
  'write:volumes',
  'delete:volumes',
  'read:audit_logs',
]

const assignmentRequests = [
  {
    name: 'API key creation',
    dto: CreateApiKeyDto,
    body: { name: 'automation' },
  },
  {
    name: 'organization role creation',
    dto: CreateOrganizationRoleDto,
    body: { name: 'Maintainer', description: 'Maintains supported resources' },
  },
  {
    name: 'organization role update',
    dto: UpdateOrganizationRoleDto,
    body: { name: 'Maintainer', description: 'Maintains supported resources' },
  },
]

describe('Assignable organization resource permission DTOs', () => {
  it.each(assignmentRequests)('accepts every supported permission for $name', async ({ dto, body }) => {
    const errors = await validate(plainToInstance(dto, { ...body, permissions: supportedPermissions }))

    expect(errors).toHaveLength(0)
  })

  it.each(
    assignmentRequests.flatMap((request) => unsupportedPermissions.map((permission) => ({ ...request, permission }))),
  )('rejects $permission during $name', async ({ dto, body, permission }) => {
    const errors = await validate(plainToInstance(dto, { ...body, permissions: [permission] }))

    expect(errors.find((error) => error.property === 'permissions')?.constraints).toHaveProperty('isIn')
  })
})
