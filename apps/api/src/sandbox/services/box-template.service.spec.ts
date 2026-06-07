/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxTemplate } from '../entities/box-template.entity'
import { BoxTemplateRegion } from '../entities/box-template-region.entity'
import { BoxTemplateState } from '../enums/box-template-state.enum'
import { BoxTemplateEvents } from '../constants/box-template-events'
import { BoxTemplateService } from './box-template.service'
import { SandboxState } from '../enums/sandbox-state.enum'

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid'),
  validate: jest.fn(() => true),
}))

function createService({
  templates = [],
  availableRegionIds = ['us'],
  defaultTemplate = 'ubuntu:24.04',
}: {
  templates?: BoxTemplate[]
  availableRegionIds?: string[]
  defaultTemplate?: string
}) {
  const boxTemplateRepository = {
    find: jest.fn(async (options?: { where?: Partial<BoxTemplate> }) => {
      const where = options?.where
      if (!where) return templates

      return templates.filter((template) =>
        Object.entries(where).every(([key, value]) => template[key as keyof BoxTemplate] === value),
      )
    }),
    findOne: jest.fn(),
    save: jest.fn(async (template: BoxTemplate) => template),
  }
  const boxTemplateRegionRepository = {
    save: jest.fn(async (templateRegion) => templateRegion),
  }
  const sandboxRepository = {
    findOne: jest.fn(),
  }
  const organizationService = {
    listAvailableRegions: jest.fn().mockResolvedValue(availableRegionIds.map((id) => ({ id }))),
  }
  const configService = {
    get: jest.fn((key: string) => (key === 'defaultTemplate' ? defaultTemplate : undefined)),
    getOrThrow: jest.fn((key: string) => {
      if (key === 'defaultRegion.id') return 'us'
      if (key === 'defaultTemplate') return defaultTemplate
      throw new Error(`Unexpected config key: ${key}`)
    }),
  }
  const eventEmitter = {
    emit: jest.fn(),
  }
  const dockerRegistryService = {
    getAvailableInternalRegistry: jest.fn(async () => ({
      url: 'http://current-registry.local',
      project: 'boxlite',
    })),
  }

  const service = new BoxTemplateService(
    sandboxRepository as any,
    boxTemplateRepository as any,
    {} as any,
    {} as any,
    {} as any,
    boxTemplateRegionRepository as any,
    organizationService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    dockerRegistryService as any,
    eventEmitter as any,
    configService as any,
  )

  return {
    service,
    sandboxRepository,
    boxTemplateRepository,
    boxTemplateRegionRepository,
    organizationService,
    eventEmitter,
    dockerRegistryService,
  }
}

function template(partial: Partial<BoxTemplate>): BoxTemplate {
  const id = partial.id ?? 'template-id'

  return {
    id,
    name: partial.name ?? 'ubuntu:24.04',
    imageName: partial.imageName ?? partial.name ?? 'ubuntu:24.04',
    general: partial.general ?? true,
    hideFromUsers: partial.hideFromUsers ?? false,
    state: partial.state ?? BoxTemplateState.ACTIVE,
    cpu: partial.cpu ?? 1,
    gpu: partial.gpu ?? 0,
    mem: partial.mem ?? 1,
    disk: partial.disk ?? 3,
    artifactRef: partial.artifactRef ?? partial.imageName ?? partial.name ?? 'ubuntu:24.04',
    templateRegions: partial.templateRegions ?? [templateRegion(id, 'us')],
  } as BoxTemplate
}

function templateRegion(templateId: string, regionId: string): BoxTemplateRegion {
  return { templateId, regionId } as BoxTemplateRegion
}

describe('BoxTemplateService system templates', () => {
  it('returns only visible active MVP templates that are available to the organization', async () => {
    const ubuntu = template({ id: 'ubuntu-id', name: 'ubuntu:24.04' })
    const alpine = template({
      id: 'alpine-id',
      name: 'alpine:3.23',
      templateRegions: [templateRegion('alpine-id', 'eu')],
    })
    const node = template({ id: 'node-id', name: 'node:22', imageName: 'node:22' })
    const hiddenDebian = template({ id: 'debian-id', name: 'debian:13-slim', hideFromUsers: true })
    const unusableDebian = template({ id: 'unusable-debian-id', name: 'debian:13-slim', artifactRef: '' })

    const { service, boxTemplateRepository, organizationService } = createService({
      templates: [alpine, node, hiddenDebian, unusableDebian, ubuntu],
      availableRegionIds: ['us'],
    })

    const templates = await service.getSystemTemplates('org-id')

    expect(boxTemplateRepository.find).toHaveBeenCalledWith({
      where: {
        general: true,
        hideFromUsers: false,
        state: BoxTemplateState.ACTIVE,
      },
      relations: ['templateRegions'],
      order: {
        name: 'ASC',
      },
    })
    expect(organizationService.listAvailableRegions).toHaveBeenCalledWith('org-id')
    expect(templates.map((template) => template.name)).toEqual(['ubuntu:24.04'])
  })

  it('sorts available templates by configured default first, then MVP order', async () => {
    const { service } = createService({
      templates: [
        template({ id: 'alpine-id', name: 'alpine:3.23' }),
        template({ id: 'debian-id', name: 'debian:13-slim' }),
        template({ id: 'ubuntu-id', name: 'ubuntu:24.04' }),
      ],
      defaultTemplate: 'debian:13-slim',
    })

    const templates = await service.getSystemTemplates('org-id')

    expect(templates.map((template) => template.name)).toEqual(['debian:13-slim', 'ubuntu:24.04', 'alpine:3.23'])
  })

  it('repairs an existing hidden system template and attaches the default region', async () => {
    const existingTemplate = template({
      id: 'ubuntu-id',
      name: 'ubuntu:24.04',
      imageName: 'old/ubuntu:24.04',
      hideFromUsers: true,
      templateRegions: [],
    })

    const { service, boxTemplateRepository, boxTemplateRegionRepository } = createService({})
    boxTemplateRepository.findOne.mockResolvedValue(existingTemplate)

    await service.ensureSystemTemplate({ id: 'admin-org-id', defaultRegionId: 'us' } as any, {
      name: 'ubuntu:24.04',
      imageName: 'ubuntu:24.04',
      displayName: 'Ubuntu 24.04 LTS',
      description: 'General-purpose Linux template',
    })

    expect(boxTemplateRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        imageName: 'ubuntu:24.04',
        hideFromUsers: false,
      }),
    )
    expect(boxTemplateRegionRepository.save).toHaveBeenCalledWith({
      templateId: 'ubuntu-id',
      regionId: 'us',
    })
  })

  it('creates missing system templates as general templates', async () => {
    const { service, boxTemplateRepository } = createService({})
    const createdTemplate = template({ id: 'debian-id', name: 'debian:13-slim' })
    boxTemplateRepository.findOne.mockResolvedValue(null)
    const createFromPull = jest.spyOn(service, 'createFromPull').mockResolvedValue(createdTemplate)

    await service.ensureSystemTemplate({ id: 'admin-org-id', defaultRegionId: 'us' } as any, {
      name: 'debian:13-slim',
      imageName: 'debian:13-slim',
      displayName: 'Debian 13 slim',
      description: 'Small Debian-based template',
    })

    expect(createFromPull).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'admin-org-id' }),
      {
        name: 'debian:13-slim',
        imageName: 'debian:13-slim',
      },
      true,
    )
  })

  it('reactivates failed system templates during startup repair', async () => {
    const existingTemplate = template({
      id: 'alpine-id',
      name: 'alpine:3.23',
      state: BoxTemplateState.ERROR,
      errorReason: 'Previous pull failed',
      templateRegions: [templateRegion('alpine-id', 'us')],
    })

    const { service, boxTemplateRepository, eventEmitter } = createService({})
    boxTemplateRepository.findOne.mockResolvedValue(existingTemplate)

    await service.ensureSystemTemplate({ id: 'admin-org-id', defaultRegionId: 'us' } as any, {
      name: 'alpine:3.23',
      imageName: 'alpine:3.23',
      displayName: 'Alpine 3.23',
      description: 'Minimal Linux template',
    })

    expect(boxTemplateRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        state: BoxTemplateState.PENDING,
        errorReason: undefined,
      }),
    )
    expect(eventEmitter.emit).toHaveBeenCalledWith(BoxTemplateEvents.ACTIVATED, expect.any(Object))
  })

  it('reactivates active system templates that are missing a usable artifact ref', async () => {
    const existingTemplate = template({
      id: 'ubuntu-id',
      name: 'ubuntu:24.04',
      state: BoxTemplateState.ACTIVE,
      artifactRef: '',
      templateRegions: [templateRegion('ubuntu-id', 'us')],
    })

    const { service, boxTemplateRepository, eventEmitter } = createService({})
    boxTemplateRepository.findOne.mockResolvedValue(existingTemplate)

    await service.ensureSystemTemplate({ id: 'admin-org-id', defaultRegionId: 'us' } as any, {
      name: 'ubuntu:24.04',
      imageName: 'ubuntu:24.04',
      displayName: 'Ubuntu 24.04 LTS',
      description: 'General-purpose Linux template',
    })

    expect(boxTemplateRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        state: BoxTemplateState.PENDING,
        errorReason: undefined,
      }),
    )
    expect(eventEmitter.emit).toHaveBeenCalledWith(BoxTemplateEvents.ACTIVATED, expect.any(Object))
  })

  it('reactivates active system templates pinned to a previous internal registry host', async () => {
    const existingTemplate = template({
      id: 'ubuntu-id',
      name: 'ubuntu:24.04',
      state: BoxTemplateState.ACTIVE,
      artifactRef: `old-registry.local/boxlite/boxlite-${'a'.repeat(64)}:boxlite`,
      initialRunnerId: 'old-runner-id',
      size: 1,
      templateRegions: [templateRegion('ubuntu-id', 'us')],
    })

    const { service, boxTemplateRepository, eventEmitter } = createService({})
    boxTemplateRepository.findOne.mockResolvedValue(existingTemplate)

    await service.ensureSystemTemplate({ id: 'admin-org-id', defaultRegionId: 'us' } as any, {
      name: 'ubuntu:24.04',
      imageName: 'ubuntu:24.04',
      displayName: 'Ubuntu 24.04 LTS',
      description: 'General-purpose Linux template',
    })

    expect(boxTemplateRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        state: BoxTemplateState.PENDING,
        artifactRef: null,
        initialRunnerId: null,
        size: null,
      }),
    )
    expect(eventEmitter.emit).toHaveBeenCalledWith(BoxTemplateEvents.ACTIVATED, expect.any(Object))
  })

  it('keeps backup snapshot references distinct when checking image cleanup', async () => {
    const imageName = 'registry.local/boxlite/backup-box:123'
    const { service, boxTemplateRepository, sandboxRepository } = createService({})
    boxTemplateRepository.findOne.mockResolvedValue(null)
    sandboxRepository.findOne.mockResolvedValue({ state: SandboxState.STOPPED })

    const canCleanup = await service.canCleanupImage(imageName)

    expect(canCleanup).toBe(false)
    const where = sandboxRepository.findOne.mock.calls[0][0].where
    const backupSnapshotQuery = where[0].existingBackupSnapshots as { _getSql: (alias: string) => string }
    expect(backupSnapshotQuery._getSql('existingBackupSnapshots')).toContain('"snapshotName"')
    expect(backupSnapshotQuery._getSql('existingBackupSnapshots')).not.toContain('"templateName"')
  })
})
