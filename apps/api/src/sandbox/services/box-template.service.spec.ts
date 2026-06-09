/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxTemplate } from '../entities/box-template.entity'
import { BoxTemplateRegion } from '../entities/box-template-region.entity'
import { generateBuildInfoHash } from '../entities/build-info.entity'
import { BoxTemplateState } from '../enums/box-template-state.enum'
import { BoxTemplateEvents } from '../constants/box-template-events'
import { BoxTemplateService } from './box-template.service'

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid'),
  validate: jest.fn(() => true),
}))

function createService({
  templates = [],
  availableRegionIds = ['us'],
  defaultTemplate = 'boxlite/base',
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
  const buildInfoRepository = {
    findOne: jest.fn(async () => null),
    create: jest.fn((buildInfo) => ({
      ...buildInfo,
      artifactRef: generateBuildInfoHash(buildInfo.dockerfileContent, buildInfo.contextHashes),
    })),
    save: jest.fn(async (buildInfo) => buildInfo),
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
    {} as any,
    boxTemplateRepository as any,
    buildInfoRepository as any,
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
    boxTemplateRepository,
    buildInfoRepository,
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
    name: partial.name ?? 'boxlite/base',
    imageName: partial.imageName ?? '',
    general: partial.general ?? true,
    hideFromUsers: partial.hideFromUsers ?? false,
    state: partial.state ?? BoxTemplateState.ACTIVE,
    cpu: partial.cpu ?? 1,
    gpu: partial.gpu ?? 0,
    mem: partial.mem ?? 1,
    disk: partial.disk ?? 3,
    artifactRef: partial.artifactRef ?? partial.imageName ?? partial.name ?? 'boxlite/base',
    entrypoint: partial.entrypoint,
    buildInfo: partial.buildInfo,
    initialRunnerId: partial.initialRunnerId,
    size: partial.size,
    templateRegions: partial.templateRegions ?? [templateRegion(id, 'us')],
  } as BoxTemplate
}

function templateRegion(templateId: string, regionId: string): BoxTemplateRegion {
  return { templateId, regionId } as BoxTemplateRegion
}

describe('BoxTemplateService system templates', () => {
  it('returns only visible active agent-ready templates that are available to the organization', async () => {
    const base = template({ id: 'base-id', name: 'boxlite/base' })
    const node = template({
      id: 'node-id',
      name: 'boxlite/node',
      templateRegions: [templateRegion('alpine-id', 'eu')],
    })
    const rawNode = template({ id: 'raw-node-id', name: 'node:22', imageName: 'node:22' })
    const hiddenPython = template({ id: 'python-id', name: 'boxlite/python', hideFromUsers: true })
    const unusablePython = template({ id: 'unusable-python-id', name: 'boxlite/python', artifactRef: '' })

    const { service, boxTemplateRepository, organizationService } = createService({
      templates: [node, rawNode, hiddenPython, unusablePython, base],
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
    expect(templates.map((template) => template.name)).toEqual(['boxlite/base'])
  })

  it('sorts available templates by configured default first, then agent-ready order', async () => {
    const { service } = createService({
      templates: [
        template({ id: 'node-id', name: 'boxlite/node' }),
        template({ id: 'python-id', name: 'boxlite/python' }),
        template({ id: 'base-id', name: 'boxlite/base' }),
      ],
      defaultTemplate: 'boxlite/python',
    })

    const templates = await service.getSystemTemplates('org-id')

    expect(templates.map((template) => template.name)).toEqual(['boxlite/python', 'boxlite/base', 'boxlite/node'])
  })

  it('repairs an existing hidden system template and attaches the default region', async () => {
    const existingTemplate = template({
      id: 'base-id',
      name: 'boxlite/base',
      imageName: 'old/runtime-base:20260601',
      hideFromUsers: true,
      templateRegions: [],
    })

    const { service, boxTemplateRepository, boxTemplateRegionRepository } = createService({})
    boxTemplateRepository.findOne.mockResolvedValue(existingTemplate)

    await service.ensureSystemTemplate({ id: 'admin-org-id', defaultRegionId: 'us' } as any, {
      name: 'boxlite/base',
      imageName: 'registry.local/boxlite/base:20260605-p0',
      displayName: 'BoxLite Base',
      description: 'General agent runtime',
      capabilities: ['curl'],
    })

    expect(boxTemplateRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        imageName: 'registry.local/boxlite/base:20260605-p0',
        hideFromUsers: false,
      }),
    )
    expect(boxTemplateRegionRepository.save).toHaveBeenCalledWith({
      templateId: 'base-id',
      regionId: 'us',
    })
  })

  it('creates missing system templates from prebuilt images as general templates', async () => {
    const { service, boxTemplateRepository } = createService({})
    const createdTemplate = template({ id: 'python-id', name: 'boxlite/python' })
    boxTemplateRepository.findOne.mockResolvedValue(null)
    const createFromPull = jest.spyOn(service, 'createFromPull').mockResolvedValue(createdTemplate)

    await service.ensureSystemTemplate({ id: 'admin-org-id', defaultRegionId: 'us' } as any, {
      name: 'boxlite/python',
      imageName: 'registry.local/boxlite/python:20260605-p0',
      displayName: 'BoxLite Python',
      description: 'Python runtime',
      capabilities: ['python', 'pip'],
    })

    expect(createFromPull).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'admin-org-id' }),
      {
        name: 'boxlite/python',
        imageName: 'registry.local/boxlite/python:20260605-p0',
      },
      true,
    )
  })

  it('migrates existing system templates away from runner buildInfo to prebuilt image refs', async () => {
    const existingTemplate = template({
      id: 'base-id',
      name: 'boxlite/base',
      imageName: '',
      buildInfo: { artifactRef: 'boxlite-old-build', dockerfileContent: 'FROM debian:bookworm-slim' } as any,
      artifactRef: 'registry.internal/boxlite/boxlite-old-build:boxlite',
      entrypoint: ['sleep', 'infinity'],
      state: BoxTemplateState.ACTIVE,
      initialRunnerId: 'runner-id',
      size: 1,
      templateRegions: [templateRegion('base-id', 'us')],
    })

    const { service, boxTemplateRepository } = createService({})
    boxTemplateRepository.findOne.mockResolvedValue(existingTemplate)

    await service.ensureSystemTemplate({ id: 'admin-org-id', defaultRegionId: 'us' } as any, {
      name: 'boxlite/base',
      imageName: 'registry.local/boxlite/base:20260605-p0',
      displayName: 'BoxLite Base',
      description: 'General agent runtime',
      capabilities: ['curl'],
    })

    expect(boxTemplateRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        imageName: 'registry.local/boxlite/base:20260605-p0',
        buildInfo: null,
        artifactRef: null,
        entrypoint: null,
        state: BoxTemplateState.PENDING,
        initialRunnerId: null,
        size: null,
      }),
    )
  })

  it('clears stale entrypoint overrides from existing system templates', async () => {
    const existingTemplate = template({
      id: 'base-id',
      name: 'boxlite/base',
      imageName: 'registry.local/boxlite/base:20260605-p0',
      artifactRef: 'registry.internal/boxlite/boxlite-base:boxlite',
      entrypoint: ['sleep', 'infinity'],
      state: BoxTemplateState.ACTIVE,
      templateRegions: [templateRegion('base-id', 'us')],
    })

    const { service, boxTemplateRepository } = createService({})
    boxTemplateRepository.findOne.mockResolvedValue(existingTemplate)

    await service.ensureSystemTemplate({ id: 'admin-org-id', defaultRegionId: 'us' } as any, {
      name: 'boxlite/base',
      imageName: 'registry.local/boxlite/base:20260605-p0',
      displayName: 'BoxLite Base',
      description: 'General agent runtime',
      capabilities: ['curl'],
    })

    expect(boxTemplateRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        entrypoint: null,
      }),
    )
  })

  it('hides legacy general OS templates after the agent-ready catalog is installed', async () => {
    const ubuntuTemplate = template({
      id: 'ubuntu-id',
      name: 'ubuntu:24.04',
      imageName: 'ubuntu:24.04',
      hideFromUsers: false,
    })
    const debianTemplate = template({
      id: 'debian-id',
      name: 'debian:13-slim',
      imageName: 'debian:13-slim',
      hideFromUsers: false,
    })

    const { service, boxTemplateRepository } = createService({})
    boxTemplateRepository.find.mockResolvedValueOnce([ubuntuTemplate, debianTemplate])

    await service.hideDeprecatedSystemTemplateAliases()

    expect(boxTemplateRepository.find).toHaveBeenCalledWith({
      where: {
        general: true,
        hideFromUsers: false,
        name: expect.anything(),
      },
    })
    expect(boxTemplateRepository.save).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'ubuntu-id', hideFromUsers: true }),
      expect.objectContaining({ id: 'debian-id', hideFromUsers: true }),
    ])
  })

  it('reactivates failed system templates during startup repair', async () => {
    const existingTemplate = template({
      id: 'node-id',
      name: 'boxlite/node',
      state: BoxTemplateState.ERROR,
      artifactRef: 'old-registry/boxlite/node:old',
      errorReason: 'Previous pull failed',
      initialRunnerId: 'stale-runner-id',
      size: 1.25,
      templateRegions: [templateRegion('node-id', 'us')],
    })

    const { service, boxTemplateRepository, eventEmitter } = createService({})
    boxTemplateRepository.findOne.mockResolvedValue(existingTemplate)

    await service.ensureSystemTemplate({ id: 'admin-org-id', defaultRegionId: 'us' } as any, {
      name: 'boxlite/node',
      imageName: 'registry.local/boxlite/node:20260605-p0',
      displayName: 'BoxLite Node',
      description: 'Node runtime',
      capabilities: ['node', 'npm'],
    })

    expect(boxTemplateRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        state: BoxTemplateState.PENDING,
        errorReason: undefined,
        artifactRef: null,
        initialRunnerId: null,
        size: null,
      }),
    )
    expect(eventEmitter.emit).toHaveBeenCalledWith(BoxTemplateEvents.ACTIVATED, expect.any(Object))
  })

  it('resumes pending system templates during startup repair', async () => {
    const existingTemplate = template({
      id: 'python-id',
      name: 'boxlite/python',
      state: BoxTemplateState.PENDING,
      imageName: 'registry.local/boxlite/python:20260605-p0',
      templateRegions: [templateRegion('python-id', 'us')],
    })

    const { service, boxTemplateRepository, eventEmitter } = createService({})
    boxTemplateRepository.findOne.mockResolvedValue(existingTemplate)

    await service.ensureSystemTemplate({ id: 'admin-org-id', defaultRegionId: 'us' } as any, {
      name: 'boxlite/python',
      imageName: 'registry.local/boxlite/python:20260605-p0',
      displayName: 'BoxLite Python',
      description: 'Python runtime',
      capabilities: ['python', 'pip'],
    })

    expect(eventEmitter.emit).toHaveBeenCalledWith(BoxTemplateEvents.ACTIVATED, expect.any(Object))
  })

  it('reactivates active system templates that are missing a usable artifact ref', async () => {
    const existingTemplate = template({
      id: 'base-id',
      name: 'boxlite/base',
      state: BoxTemplateState.ACTIVE,
      artifactRef: '',
      templateRegions: [templateRegion('base-id', 'us')],
    })

    const { service, boxTemplateRepository, eventEmitter } = createService({})
    boxTemplateRepository.findOne.mockResolvedValue(existingTemplate)

    await service.ensureSystemTemplate({ id: 'admin-org-id', defaultRegionId: 'us' } as any, {
      name: 'boxlite/base',
      imageName: 'registry.local/boxlite/base:20260605-p0',
      displayName: 'BoxLite Base',
      description: 'General agent runtime',
      capabilities: ['curl'],
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
      id: 'base-id',
      name: 'boxlite/base',
      state: BoxTemplateState.ACTIVE,
      artifactRef: `old-registry.local/boxlite/boxlite-${'a'.repeat(64)}:boxlite`,
      initialRunnerId: 'old-runner-id',
      size: 1,
      templateRegions: [templateRegion('ubuntu-id', 'us')],
    })

    const { service, boxTemplateRepository, eventEmitter } = createService({})
    boxTemplateRepository.findOne.mockResolvedValue(existingTemplate)

    await service.ensureSystemTemplate({ id: 'admin-org-id', defaultRegionId: 'us' } as any, {
      name: 'boxlite/base',
      imageName: 'registry.local/boxlite/base:20260605-p0',
      displayName: 'BoxLite Base',
      description: 'General agent runtime',
      capabilities: ['curl'],
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
})
