/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestError } from '../../exceptions/bad-request.exception'
import { OrgBoxImageStatus } from '../enums/org-box-image-status.enum'
import { OrgBoxImageService } from './org-box-image.service'

const BASE_REF = 'ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3'

describe('OrgBoxImageService', () => {
  const ENV_KEYS = [
    'BOXLITE_SYSTEM_BASE_IMAGE',
    'BOXLITE_SYSTEM_PYTHON_IMAGE',
    'BOXLITE_SYSTEM_NODE_IMAGE',
    'BOXLITE_SYSTEM_IMAGES',
  ]
  const saved: Record<string, string | undefined> = {}
  let repo: {
    create: jest.Mock
    save: jest.Mock
    find: jest.Mock
    findOne: jest.Mock
  }
  let service: OrgBoxImageService

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }

    repo = {
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => ({ id: 'img_1', ...value })),
      find: jest.fn(async () => []),
      findOne: jest.fn(async () => null),
    }
    service = new OrgBoxImageService(repo as any)
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('defaults to the system base image', async () => {
    await expect(service.resolveImage('org_1', undefined)).resolves.toBe(BASE_REF)
    expect(repo.findOne).not.toHaveBeenCalled()
  })

  it('resolves system images before querying organization images', async () => {
    await expect(service.resolveImage('org_1', 'base')).resolves.toBe(BASE_REF)
    expect(repo.findOne).not.toHaveBeenCalled()
  })

  it('resolves active organization images by name or ref within the organization', async () => {
    repo.findOne.mockResolvedValueOnce({
      organizationId: 'org_1',
      name: 'hermes',
      ref: 'sam2026go/hermes-agent:boxlite',
      status: OrgBoxImageStatus.ACTIVE,
    })

    await expect(service.resolveImage('org_1', 'hermes')).resolves.toBe('sam2026go/hermes-agent:boxlite')
    expect(repo.findOne).toHaveBeenCalledWith({
      where: [
        { organizationId: 'org_1', status: OrgBoxImageStatus.ACTIVE, name: 'hermes' },
        { organizationId: 'org_1', status: OrgBoxImageStatus.ACTIVE, ref: 'hermes' },
      ],
    })
  })

  it('does not resolve another organization image with the same selector', async () => {
    repo.findOne.mockImplementation(async ({ where }) => {
      const scopedName = where[0]
      if (scopedName.organizationId === 'org_2' && scopedName.name === 'hermes') {
        return {
          organizationId: 'org_2',
          name: 'hermes',
          ref: 'sam2026go/hermes-agent:boxlite',
          status: OrgBoxImageStatus.ACTIVE,
        }
      }
      return null
    })
    repo.find.mockResolvedValueOnce([])

    await expect(service.resolveImage('org_1', 'hermes')).rejects.toThrow(BadRequestError)
    await expect(service.resolveImage('org_2', 'hermes')).resolves.toBe('sam2026go/hermes-agent:boxlite')
  })

  it('rejects images outside the system and organization scopes', async () => {
    repo.find.mockResolvedValueOnce([])
    await expect(service.resolveImage('org_1', 'alpine:3.23')).rejects.toThrow(BadRequestError)
  })

  it('lists system images before organization images', async () => {
    repo.find.mockResolvedValueOnce([
      {
        name: 'hermes',
        ref: 'sam2026go/hermes-agent:boxlite',
        status: OrgBoxImageStatus.ACTIVE,
      },
    ])

    await expect(service.listAvailable('org_1')).resolves.toEqual(
      expect.arrayContaining([
        { name: 'base', ref: BASE_REF, source: 'system' },
        {
          name: 'hermes',
          ref: 'sam2026go/hermes-agent:boxlite',
          source: 'organization',
          status: OrgBoxImageStatus.ACTIVE,
        },
      ]),
    )
  })

  it('validates refs when registering an organization image', async () => {
    await expect(service.create('org_1', { name: 'bad', ref: 'https://example.com/image' }, 'user_1')).rejects.toThrow(
      BadRequestError,
    )

    await service.create('org_1', { name: 'hermes', ref: 'sam2026go/hermes-agent:boxlite' }, 'user_1')
    expect(repo.create).toHaveBeenCalledWith({
      organizationId: 'org_1',
      name: 'hermes',
      ref: 'sam2026go/hermes-agent:boxlite',
      status: OrgBoxImageStatus.ACTIVE,
      createdBy: 'user_1',
    })
  })
})
