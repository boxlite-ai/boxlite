/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { NotFoundException } from '@nestjs/common'
import { McpServer, type CallToolResult, type ServerContext } from '@modelcontextprotocol/server'
import { VolumeService } from '../../../box/services/volume.service'
import { VolumeState } from '../../../box/enums/volume-state.enum'
import { OrganizationMemberRole } from '../../../organization/enums/organization-member-role.enum'
import { SystemRole } from '../../../user/enums/system-role.enum'
import { VolumeTools } from './volume-tools'
import {
  accessFixture,
  caller,
  FOREIGN_ORGANIZATION_ID,
  ORGANIZATION_ID,
  RESOURCE_ID,
  toolHarness,
} from '../../tests/tool-harness'

describe('MCP volume tools', () => {
  let fixture: ReturnType<typeof accessFixture>
  let harness: Awaited<ReturnType<typeof toolHarness>>
  let volumes: { create: jest.Mock; findAll: jest.Mock; findOne: jest.Mock; waitForReady: jest.Mock; delete: jest.Mock }
  let tools: VolumeTools
  const volume = {
    id: RESOURCE_ID,
    organizationId: ORGANIZATION_ID,
    name: 'my-data',
    state: VolumeState.READY,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
  }

  beforeEach(async () => {
    fixture = accessFixture()
    volumes = {
      create: jest.fn().mockResolvedValue(volume),
      findAll: jest.fn().mockResolvedValue([volume]),
      findOne: jest.fn().mockResolvedValue(volume),
      waitForReady: jest.fn().mockResolvedValue(volume),
      delete: jest.fn().mockResolvedValue(undefined),
    }
    tools = new VolumeTools(fixture.access, volumes as unknown as VolumeService, fixture.audit)
    harness = await toolHarness((server) => tools.register(server, caller))
  })
  afterEach(async () => {
    await harness.close()
  })

  function callbackFor(name: string) {
    const server = new McpServer({ name: 'cancellation-test', version: '0' })
    const registrations = jest.spyOn(server, 'registerTool')
    tools.register(server, caller)
    const registration = registrations.mock.calls.find(([registeredName]) => registeredName === name)
    if (!registration) throw new Error('Tool was not registered')
    return registration[2] as (args: Record<string, unknown>, context: ServerContext) => Promise<CallToolResult>
  }

  it.each(['create_volume', 'delete_volume'])('stops %s when cancelled during membership admission', async (name) => {
    const entered = deferred<void>()
    const membership = deferred<typeof fixture.member>()
    fixture.memberships.findOne.mockImplementationOnce(() => {
      entered.resolve()
      return membership.promise
    })
    const controller = new AbortController()
    const result = callbackFor(name)(
      { organization_id: ORGANIZATION_ID, ...(name === 'delete_volume' ? { volume_id: RESOURCE_ID } : {}) },
      {
        mcpReq: { signal: controller.signal },
      } as ServerContext,
    )
    await entered.promise
    controller.abort()
    membership.resolve(fixture.member)
    expect((await result).isError).toBe(true)
    expect(fixture.organizations.findOne).not.toHaveBeenCalled()
    expect(volumes.create).not.toHaveBeenCalled()
    expect(volumes.delete).not.toHaveBeenCalled()
    expect(fixture.auditService.createLog).not.toHaveBeenCalled()
  })

  it.each(['create_volume', 'delete_volume'])('stops %s when cancelled during audit admission', async (name) => {
    const entered = deferred<void>()
    const admission = deferred<{ id: string }>()
    fixture.auditService.createLog.mockImplementationOnce(() => {
      entered.resolve()
      return admission.promise
    })
    const controller = new AbortController()
    const result = callbackFor(name)(
      { organization_id: ORGANIZATION_ID, ...(name === 'delete_volume' ? { volume_id: RESOURCE_ID } : {}) },
      {
        mcpReq: { signal: controller.signal },
      } as ServerContext,
    )
    await entered.promise
    controller.abort()
    admission.resolve({ id: 'cancelled-audit' })
    expect((await result).isError).toBe(true)
    expect(volumes.create).not.toHaveBeenCalled()
    expect(volumes.delete).not.toHaveBeenCalled()
    expect(fixture.auditService.updateLog).toHaveBeenCalledWith(
      'cancelled-audit',
      expect.objectContaining({ statusCode: 499 }),
    )
  })

  it('advertises strict typed input/output and safe read annotations', async () => {
    const { result } = await harness.list()
    expect(result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
      'create_volume',
      'delete_volume',
      'get_volume',
      'list_volumes',
    ])
    for (const tool of result.tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false)
      expect(tool.outputSchema.additionalProperties).toBe(false)
      expect(tool.annotations.openWorldHint).toBe(false)
    }
  })

  it.each(['list_volumes', 'get_volume', 'create_volume', 'delete_volume'])(
    'authorizes membership before %s business work',
    async (name) => {
      fixture.memberships.findOne.mockResolvedValue(null)
      const args = name.includes('get') || name.includes('delete') ? { volume_id: RESOURCE_ID } : {}
      const { result } = await harness.call(name, { organization_id: FOREIGN_ORGANIZATION_ID, ...args })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toBeUndefined()
      expect(fixture.organizations.findOne).not.toHaveBeenCalled()
      for (const operation of Object.values(volumes)) expect(operation).not.toHaveBeenCalled()
    },
  )

  it.each(['list_volumes', 'get_volume', 'create_volume', 'delete_volume'])(
    'checks real resource permissions for %s',
    async (name) => {
      fixture.member.assignedRoles = []
      const args = name.includes('get') || name.includes('delete') ? { volume_id: RESOURCE_ID } : {}
      expect((await harness.call(name, { organization_id: ORGANIZATION_ID, ...args })).result.isError).toBe(true)
      for (const operation of Object.values(volumes)) expect(operation).not.toHaveBeenCalled()
    },
  )

  it('maps service volumes into REST-shaped structured and text replies', async () => {
    const { result } = await harness.call('list_volumes', { organization_id: ORGANIZATION_ID })
    expect(result.structuredContent).toEqual({
      volumes: [{ id: RESOURCE_ID, name: 'my-data', state: 'ready', created_at: '2026-01-01T00:00:00.000Z' }],
    })
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent)
    expect(volumes.findAll).toHaveBeenCalledWith(ORGANIZATION_ID)
    const get = await harness.call('get_volume', { organization_id: ORGANIZATION_ID, volume_id: RESOURCE_ID })
    expect(get.result.structuredContent.updated_at).toBe('2026-01-02T00:00:00.000Z')
  })

  it('accepts interactive owners and validates names with the existing DTO before create', async () => {
    fixture.member.role = OrganizationMemberRole.OWNER
    fixture.member.assignedRoles = []
    expect(
      (await harness.call('create_volume', { organization_id: ORGANIZATION_ID, name: '/host/path' })).result.isError,
    ).toBe(true)
    expect(volumes.create).not.toHaveBeenCalled()
    const { result } = await harness.call('create_volume', { organization_id: ORGANIZATION_ID })
    expect(result.structuredContent.id).toBe(RESOURCE_ID)
    expect(volumes.create).toHaveBeenCalledWith(fixture.organization, {})
    expect(volumes.waitForReady).toHaveBeenCalledWith(RESOURCE_ID, 30)
    expect(fixture.auditService.createLog.mock.invocationCallOrder[0]).toBeLessThan(
      volumes.create.mock.invocationCallOrder[0],
    )
    expect(fixture.auditService.updateLog).toHaveBeenCalledWith('audit-id', { statusCode: 200, targetId: RESOURCE_ID })
  })

  it('normalizes a healthy database row with a nullable error reason', async () => {
    volumes.findOne.mockResolvedValue({ ...volume, errorReason: null, lastUsedAt: null })
    const { result } = await harness.call('get_volume', { organization_id: ORGANIZATION_ID, volume_id: RESOURCE_ID })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual(expect.objectContaining({ id: RESOURCE_ID, state: 'ready' }))
    expect(result.structuredContent.error_reason).toBeUndefined()
    expect(result.structuredContent.last_used_at).toBeUndefined()
  })

  it.each(['get_volume', 'delete_volume'])('rejects foreign volume ownership before %s effects', async (name) => {
    volumes.findOne.mockResolvedValue({ ...volume, organizationId: FOREIGN_ORGANIZATION_ID })
    const { result } = await harness.call(name, {
      organization_id: ORGANIZATION_ID,
      volume_id: RESOURCE_ID,
      ...(name === 'delete_volume' ? { force: true } : {}),
    })
    expect(result.isError).toBe(true)
    expect(volumes.delete).not.toHaveBeenCalled()
    expect(fixture.auditService.createLog).not.toHaveBeenCalled()
  })

  it('returns accepted deletion and preserves force on an already absent resource', async () => {
    const args = { organization_id: ORGANIZATION_ID, volume_id: RESOURCE_ID, force: true }
    expect((await harness.call('delete_volume', args)).result.structuredContent).toEqual({ accepted: true })
    expect(volumes.delete).toHaveBeenCalledWith(RESOURCE_ID, true)
    volumes.findOne.mockRejectedValue(new NotFoundException())
    volumes.delete.mockClear()
    expect((await harness.call('delete_volume', args)).result.structuredContent).toEqual({ accepted: true })
    expect(volumes.delete).not.toHaveBeenCalled()
    expect((await harness.call('delete_volume', { ...args, force: false })).result.isError).toBe(true)
  })

  it('blocks effects when audit admission fails and sanitizes service failures', async () => {
    fixture.auditService.createLog.mockRejectedValueOnce(new Error('private audit details'))
    expect((await harness.call('create_volume', { organization_id: ORGANIZATION_ID })).result.content[0].text).toBe(
      'Tool operation failed',
    )
    expect(volumes.create).not.toHaveBeenCalled()
    volumes.create.mockRejectedValueOnce(new Error('private backend details'))
    const { result } = await harness.call('create_volume', { organization_id: ORGANIZATION_ID })
    expect(result.content[0].text).toBe('Tool operation failed')
    expect(fixture.auditService.updateLog).toHaveBeenCalledWith('audit-id', { statusCode: 500, targetId: undefined })
  })

  it('rejects invalid UUIDs, unknown input and wrong types before organization access', async () => {
    for (const args of [
      { organization_id: 'invalid' },
      { organization_id: ORGANIZATION_ID, extra: true },
      { organization_id: ORGANIZATION_ID, name: null },
    ]) {
      const body = await harness.call('create_volume', args)
      expect(body.error || body.result?.isError).toBeTruthy()
    }
    expect(fixture.memberships.findOne).not.toHaveBeenCalled()
  })

  it('never grants an administrator a membership bypass', async () => {
    caller.role = SystemRole.ADMIN
    fixture.memberships.findOne.mockResolvedValue(null)
    try {
      expect((await harness.call('list_volumes', { organization_id: ORGANIZATION_ID })).result.isError).toBe(true)
    } finally {
      caller.role = SystemRole.USER
    }
    expect(volumes.findAll).not.toHaveBeenCalled()
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}
