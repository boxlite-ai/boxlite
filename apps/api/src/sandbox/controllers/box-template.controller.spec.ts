/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { PATH_METADATA } from '@nestjs/common/constants'
import { SandboxController } from './sandbox.controller'
import { SandboxState } from '../enums/sandbox-state.enum'
import { BoxTemplateState } from '../enums/box-template-state.enum'
import { SystemRole } from '../../user/enums/system-role.enum'
import { BoxTemplateController } from './box-template.controller'
import { BoxTemplateSortDirection, BoxTemplateSortField } from '../dto/list-box-templates-query.dto'

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid'),
  validate: jest.fn(() => true),
}))

function redisMock() {
  return {
    duplicate: jest.fn(() => ({
      subscribe: jest.fn(),
      on: jest.fn(),
    })),
  }
}

describe('BoxTemplateController', () => {
  it('publishes templates under the /templates route', () => {
    expect(Reflect.getMetadata(PATH_METADATA, BoxTemplateController)).toBe('templates')
  })

  it('returns system template list when no pagination query is present', async () => {
    const template = createTemplate()
    const boxTemplateService = {
      getSystemTemplates: jest.fn().mockResolvedValue([template]),
      getAllBoxTemplates: jest.fn(),
    }
    const controller = new BoxTemplateController(boxTemplateService as any, {} as any)

    const result = await controller.listBoxTemplates(
      { organizationId: 'org-id' } as any,
      { page: 1, limit: 100 } as any,
      { query: {} },
    )

    expect(Array.isArray(result)).toBe(true)
    expect(result).toEqual([expect.objectContaining({ id: 'template-id', name: 'boxlite/base' })])
    expect(boxTemplateService.getSystemTemplates).toHaveBeenCalledWith('org-id')
    expect(boxTemplateService.getAllBoxTemplates).not.toHaveBeenCalled()
  })

  it('returns paginated templates when a pagination query is present', async () => {
    const template = createTemplate()
    const boxTemplateService = {
      getSystemTemplates: jest.fn(),
      getAllBoxTemplates: jest.fn().mockResolvedValue({
        items: [template],
        total: 1,
        page: 1,
        totalPages: 1,
      }),
    }
    const controller = new BoxTemplateController(boxTemplateService as any, {} as any)

    const result = await controller.listBoxTemplates(
      { organizationId: 'org-id' } as any,
      {
        page: 1,
        limit: 100,
        sort: BoxTemplateSortField.LAST_USED_AT,
        order: BoxTemplateSortDirection.DESC,
      } as any,
      { query: { page: '1' } },
    )

    expect(result).toEqual({
      items: [expect.objectContaining({ id: 'template-id', name: 'boxlite/base' })],
      total: 1,
      page: 1,
      totalPages: 1,
    })
    expect(boxTemplateService.getSystemTemplates).not.toHaveBeenCalled()
    expect(boxTemplateService.getAllBoxTemplates).toHaveBeenCalledWith(
      'org-id',
      1,
      100,
      { name: undefined },
      { field: BoxTemplateSortField.LAST_USED_AT, direction: BoxTemplateSortDirection.DESC },
    )
  })
})

function createTemplate() {
  const now = new Date('2026-01-01T00:00:00.000Z')

  return {
    id: 'template-id',
    organizationId: undefined,
    general: true,
    name: 'boxlite/base',
    imageName: '',
    artifactRef: 'registry.local/boxlite/runtime-base@sha256:abc',
    state: BoxTemplateState.ACTIVE,
    errorReason: undefined,
    cpu: 1,
    gpu: 0,
    mem: 1,
    disk: 3,
    buildInfo: undefined,
    initialRunnerId: undefined,
    templateRegions: [],
    createdAt: now,
    updatedAt: now,
    lastUsedAt: undefined,
  }
}

describe('SandboxController template creation contract', () => {
  it('allows non-admin users to create a box from a template with resource overrides', async () => {
    const sandboxService = {
      createFromTemplate: jest.fn().mockResolvedValue({
        id: 'box-id',
        state: SandboxState.STARTED,
      }),
    }
    const controller = new SandboxController({} as any, sandboxService as any, redisMock() as any)
    const organization = { id: 'org-id' }
    const createBoxDto = {
      name: 'template-box',
      templateId: 'ubuntu-template-id',
      cpu: 2,
      memory: 4,
      disk: 20,
    }

    await expect(
      controller.createSandbox(
        {
          organization,
          organizationId: organization.id,
          role: SystemRole.USER,
        } as any,
        createBoxDto as any,
      ),
    ).resolves.toEqual(expect.objectContaining({ id: 'box-id' }))

    expect(sandboxService.createFromTemplate).toHaveBeenCalledWith(createBoxDto, organization)
  })
})
