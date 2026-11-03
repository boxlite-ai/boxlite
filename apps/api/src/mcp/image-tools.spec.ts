/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { NotFoundException } from '@nestjs/common'
import { ImageCatalogService } from '../image/services/image-catalog.service'
import { ImageTools } from './image-tools'
import { accessFixture, caller, ORGANIZATION_ID, toolHarness } from './tests/tool-harness'

const IMAGE = 'quay.io/acme/app'
const DIGEST = 'sha256:' + 'a'.repeat(64)
const NAMES = [
  'list_images',
  'get_image_usage',
  'get_image',
  'create_image_alias',
  'delete_image_alias',
  'delete_image',
]

describe('MCP image tools', () => {
  let fixture: ReturnType<typeof accessFixture>
  let harness: Awaited<ReturnType<typeof toolHarness>>
  let images: {
    listReferences: jest.Mock
    usage: jest.Mock
    get: jest.Mock
    createAlias: jest.Mock
    deleteAlias: jest.Mock
    delete: jest.Mock
  }
  const detail = {
    name: IMAGE,
    aliases: ['stable'],
    curated: false,
    versions: [
      {
        digest: DIGEST,
        sizeBytes: 42,
        sourceRef: IMAGE + ':v1',
        createdAt: '2026-01-01',
        aliases: ['stable'],
        lastUsedAt: null,
        upstreamMissingAt: null,
      },
    ],
    history: [{ aliasName: 'stable', fromDigest: null, toDigest: DIGEST, actorId: 'member', createdAt: '2026-01-02' }],
  }

  beforeEach(async () => {
    fixture = accessFixture()
    images = {
      listReferences: jest
        .fn()
        .mockResolvedValue([
          {
            reference: IMAGE + ':stable',
            name: IMAGE,
            tag: 'stable',
            digest: DIGEST,
            sizeBytes: 42,
            recordedAt: new Date('2026-01-01'),
          },
        ]),
      usage: jest.fn().mockResolvedValue({ count: 1, limit: 20, knownBytes: 42 }),
      get: jest.fn().mockResolvedValue(detail),
      createAlias: jest.fn().mockResolvedValue(detail),
      deleteAlias: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    }
    const tools = new ImageTools(fixture.access, images as unknown as ImageCatalogService, fixture.audit)
    harness = await toolHarness((server) => tools.register(server, caller))
  })
  afterEach(async () => {
    await harness.close()
  })

  function args(name: string) {
    return {
      organization_id: ORGANIZATION_ID,
      ...(name === 'list_images' || name === 'get_image_usage' ? {} : { image_name: IMAGE }),
      ...(name.includes('alias') ? { alias: 'stable' } : {}),
      ...(name === 'create_image_alias' ? { digest: DIGEST } : {}),
    }
  }

  it('advertises exactly the six strict catalog tools with operation-specific annotations', async () => {
    const { result } = await harness.list()
    expect(result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([...NAMES].sort())
    for (const tool of result.tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false)
      expect(tool.outputSchema.additionalProperties).toBe(false)
      expect(tool.annotations.destructiveHint).toBe(tool.name.startsWith('delete_'))
    }
  })

  it.each(NAMES)('requires actual membership before %s', async (name) => {
    fixture.memberships.findOne.mockResolvedValue(null)
    expect((await harness.call(name, args(name))).result.isError).toBe(true)
    for (const operation of Object.values(images)) expect(operation).not.toHaveBeenCalled()
  })

  it.each(NAMES)('checks resource roles before %s', async (name) => {
    fixture.member.assignedRoles = []
    expect((await harness.call(name, args(name))).result.isError).toBe(true)
    for (const operation of Object.values(images)) expect(operation).not.toHaveBeenCalled()
  })

  it('maps catalog references, usage, versions and history through shared REST mappers', async () => {
    const listing = (await harness.call('list_images', args('list_images'))).result
    expect(listing.structuredContent.images[0]).toEqual({
      reference: IMAGE + ':stable',
      repository: IMAGE,
      tag: 'stable',
      id: DIGEST,
      size_bytes: 42,
      cached_at: '2026-01-01T00:00:00.000Z',
    })
    expect(JSON.parse(listing.content[0].text)).toEqual(listing.structuredContent)
    expect((await harness.call('get_image_usage', args('get_image_usage'))).result.structuredContent).toEqual({
      count: 1,
      limit: 20,
      known_bytes: 42,
    })
    const result = (await harness.call('get_image', args('get_image'))).result
    expect(result.structuredContent.versions[0]).toEqual({
      digest: DIGEST,
      size_bytes: 42,
      source_ref: IMAGE + ':v1',
      recorded_at: '2026-01-01',
      aliases: ['stable'],
      last_used_at: null,
      upstream_missing_at: null,
    })
    expect(result.structuredContent.history[0]).toEqual({
      alias: 'stable',
      from_digest: null,
      to_digest: DIGEST,
      actor: 'member',
      recorded_at: '2026-01-02',
    })
    expect(images.get).toHaveBeenCalledWith(fixture.organization, IMAGE)
  })

  it('uses digest-based alias DTOs and audit admission before mutations', async () => {
    expect((await harness.call('create_image_alias', args('create_image_alias'))).result.structuredContent.name).toBe(
      IMAGE,
    )
    expect(images.createAlias).toHaveBeenCalledWith(
      fixture.organization,
      IMAGE,
      'stable',
      { digest: DIGEST },
      caller.userId,
    )
    expect(fixture.auditService.createLog.mock.invocationCallOrder[0]).toBeLessThan(
      images.createAlias.mock.invocationCallOrder[0],
    )
    expect(fixture.auditService.createLog).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { tool: 'create_image_alias' }, targetId: IMAGE }),
    )
    expect((await harness.call('delete_image_alias', args('delete_image_alias'))).result.structuredContent).toEqual({
      completed: true,
    })
    expect(images.deleteAlias).toHaveBeenCalledWith(fixture.organization, IMAGE, 'stable')
    expect((await harness.call('delete_image', args('delete_image'))).result.structuredContent).toEqual({
      completed: true,
    })
    expect(images.delete).toHaveBeenCalledWith(fixture.organization, IMAGE)
  })

  it.each(['get_image', 'create_image_alias', 'delete_image_alias', 'delete_image'])(
    'scopes missing or foreign image denial before %s effects',
    async (name) => {
      images.get.mockRejectedValue(new NotFoundException('private resource details'))
      const { result } = await harness.call(name, args(name))
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toBe('Resource not found or not accessible')
      expect(images.get).toHaveBeenCalledWith(fixture.organization, IMAGE)
      expect(images.createAlias).not.toHaveBeenCalled()
      expect(images.deleteAlias).not.toHaveBeenCalled()
      expect(images.delete).not.toHaveBeenCalled()
      expect(fixture.auditService.createLog).not.toHaveBeenCalled()
    },
  )

  it('rejects invalid aliases, digests and unknown options before organization access', async () => {
    for (const request of [
      { ...args('create_image_alias'), alias: 'bad/tag' },
      { ...args('create_image_alias'), digest: 'not-a-digest' },
      { ...args('get_image'), force: true },
    ]) {
      const body = await harness.call(
        'image_name' in request && 'digest' in request ? 'create_image_alias' : 'get_image',
        request,
      )
      expect(body.error || body.result?.isError).toBeTruthy()
    }
    expect(fixture.memberships.findOne).not.toHaveBeenCalled()
  })
})
