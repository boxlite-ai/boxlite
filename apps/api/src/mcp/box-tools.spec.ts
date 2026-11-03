/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { NotFoundException } from '@nestjs/common'
import { BoxService } from '../box/services/box.service'
import { BoxStateWaiterService } from '../box/services/box-state-waiter.service'
import { CommerceBoxLimitService } from '../boxlite-rest/commerce-box-limit.service'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxDesiredState } from '../box/enums/box-desired-state.enum'
import { ActorKind } from '../common/context/actor-kind.enum'
import { OrganizationResourcePermission as Permission } from '../organization/enums/organization-resource-permission.enum'
import { BoxTools } from './box-tools'
import {
  accessFixture,
  caller,
  FOREIGN_ORGANIZATION_ID,
  ORGANIZATION_ID,
  RESOURCE_ID,
  toolHarness,
} from './tests/tool-harness'

const NAME = '我的 Box with spaces'
const NAMES = ['create_box', 'get_box', 'box_exists', 'delete_box', 'start_box', 'stop_box']
const INPUT = { organization_id: ORGANIZATION_ID, box_id: NAME }

describe('MCP Box lifecycle tools', () => {
  let fixture: ReturnType<typeof accessFixture>
  let harness: Awaited<ReturnType<typeof toolHarness>>
  let boxes: {
    create: jest.Mock
    toBoxDto: jest.Mock
    toBoxDtoWithExitCode: jest.Mock
    destroy: jest.Mock
    start: jest.Mock
    stop: jest.Mock
  }
  let waiter: { waitForStarted: jest.Mock }
  let limits: { resolveMaxCreatedBoxes: jest.Mock }
  const entity = {
    id: RESOURCE_ID,
    organizationId: ORGANIZATION_ID,
    name: NAME,
    state: BoxState.STOPPED,
    desiredState: BoxDesiredState.STOPPED,
  }
  const dto = {
    id: RESOURCE_ID,
    name: NAME,
    state: BoxState.STARTED,
    memory: 2,
    cpu: 1,
    image: 'python',
    exitCode: 0,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-02',
  }

  beforeEach(async () => {
    fixture = accessFixture()
    fixture.boxes.findOneByIdOrName.mockResolvedValue(entity)
    boxes = {
      create: jest.fn().mockResolvedValue(dto),
      toBoxDto: jest.fn().mockImplementation(async (box) => ({ ...dto, state: box.state })),
      toBoxDtoWithExitCode: jest.fn().mockResolvedValue(dto),
      destroy: jest.fn().mockResolvedValue(entity),
      start: jest.fn().mockResolvedValue({ ...entity, state: BoxState.STARTING }),
      stop: jest.fn().mockResolvedValue({ ...entity, state: BoxState.STOPPING }),
    }
    waiter = { waitForStarted: jest.fn().mockResolvedValue(dto) }
    limits = { resolveMaxCreatedBoxes: jest.fn().mockResolvedValue(3) }
    const tools = new BoxTools(
      fixture.access,
      boxes as unknown as BoxService,
      waiter as unknown as BoxStateWaiterService,
      limits as unknown as CommerceBoxLimitService,
      fixture.audit,
    )
    harness = await toolHarness((server) => tools.register(server, caller))
  })
  afterEach(async () => {
    await harness.close()
  })

  function args(name: string) {
    return name === 'create_box' ? { organization_id: ORGANIZATION_ID } : INPUT
  }

  it('advertises six strict tools and destructive stop/delete hints', async () => {
    const { result } = await harness.list()
    expect(result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([...NAMES].sort())
    for (const tool of result.tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false)
      expect(tool.outputSchema.additionalProperties).toBe(false)
      expect(tool.annotations.destructiveHint).toBe(['delete_box', 'stop_box'].includes(tool.name))
    }
  })
  it.each(NAMES)('requires actual membership before %s', async (name) => {
    fixture.memberships.findOne.mockResolvedValue(null)
    expect((await harness.call(name, args(name))).result.isError).toBe(true)
    expect(fixture.boxes.findOneByIdOrName).not.toHaveBeenCalled()
    for (const operation of Object.values(boxes)) expect(operation).not.toHaveBeenCalled()
    expect(limits.resolveMaxCreatedBoxes).not.toHaveBeenCalled()
  })
  it.each(['create_box', 'delete_box', 'start_box', 'stop_box'])(
    'checks actual write/delete permissions before %s',
    async (name) => {
      fixture.member.assignedRoles = []
      expect((await harness.call(name, args(name))).result.isError).toBe(true)
      expect(fixture.boxes.findOneByIdOrName).not.toHaveBeenCalled()
      for (const operation of Object.values(boxes)) expect(operation).not.toHaveBeenCalled()
    },
  )
  it('keeps reads membership-only, accepts exact Unicode names and maps exit code zero', async () => {
    fixture.member.assignedRoles = []
    const result = (await harness.call('get_box', INPUT)).result
    expect(result.structuredContent).toEqual(
      expect.objectContaining({ box_id: RESOURCE_ID, name: NAME, memory_mib: 2048, exit_code: 0 }),
    )
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent)
    expect(fixture.boxes.findOneByIdOrName).toHaveBeenCalledWith(NAME, ORGANIZATION_ID)
    expect((await harness.call('box_exists', INPUT)).result.structuredContent).toEqual({ exists: true })
  })
  it('uses hosted DTO mapping, Commerce admission, user context, and secret-free audit metadata', async () => {
    const request = {
      organization_id: ORGANIZATION_ID,
      name: NAME,
      image: 'python',
      memory_mib: 1536,
      user: '1000',
      env: { TOKEN: 'private-env' },
      secrets: [{ name: 'API_KEY', value: 'private-secret' }],
      volumes: [{ managed_volume: 'my-data', guest_path: '/data' }],
    }
    const result = (await harness.call('create_box', request)).result
    expect(result.structuredContent.status).toBe('running')
    expect(limits.resolveMaxCreatedBoxes).toHaveBeenCalledWith(ORGANIZATION_ID)
    expect(boxes.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: NAME,
        memory: 2,
        runAsUser: '1000',
        volumes: [{ volumeId: 'my-data', mountPath: '/data' }],
      }),
      fixture.organization,
      expect.objectContaining({ actorKind: ActorKind.USER }),
      { maxCreatedBoxes: 3 },
    )
    expect(fixture.auditService.createLog.mock.invocationCallOrder[0]).toBeLessThan(
      boxes.create.mock.invocationCallOrder[0],
    )
    const audits = JSON.stringify([
      fixture.auditService.createLog.mock.calls,
      fixture.auditService.updateLog.mock.calls,
    ])
    expect(audits).not.toContain('private-env')
    expect(audits).not.toContain('private-secret')
    expect(waiter.waitForStarted).not.toHaveBeenCalled()
  })
  it.each([
    [Permission.WRITE_BOXES],
    [Permission.WRITE_BOXES, Permission.READ_VOLUMES],
    [Permission.WRITE_BOXES, Permission.WRITE_VOLUMES],
  ])('requires both managed-volume permissions when mounts are supplied', async (...permissions) => {
    fixture.member.assignedRoles = [{ permissions }]
    const result = (
      await harness.call('create_box', {
        organization_id: ORGANIZATION_ID,
        volumes: [{ managed_volume: 'my-data', guest_path: '/data' }],
      })
    ).result
    expect(result.isError).toBe(true)
    expect(boxes.create).not.toHaveBeenCalled()
    expect(limits.resolveMaxCreatedBoxes).not.toHaveBeenCalled()
    expect(fixture.auditService.createLog).not.toHaveBeenCalled()
  })
  it('does not require volume permissions without mounts and retains the create startup wait', async () => {
    fixture.member.assignedRoles = [{ permissions: [Permission.WRITE_BOXES] }]
    boxes.create.mockResolvedValue({ ...dto, state: BoxState.CREATING })
    expect(
      (await harness.call('create_box', { organization_id: ORGANIZATION_ID })).result.structuredContent.status,
    ).toBe('running')
    expect(waiter.waitForStarted).toHaveBeenCalledWith(RESOURCE_ID, ORGANIZATION_ID, 30)
  })
  it('preserves start waiting, stop progress, deletion admission and user business context', async () => {
    expect((await harness.call('start_box', INPUT)).result.structuredContent.status).toBe('running')
    expect(boxes.start).toHaveBeenCalledWith(RESOURCE_ID, fixture.organization)
    expect(waiter.waitForStarted).toHaveBeenCalledWith(RESOURCE_ID, ORGANIZATION_ID, 30)
    expect((await harness.call('stop_box', INPUT)).result.structuredContent.status).toBe('stopping')
    expect(boxes.stop).toHaveBeenCalledWith(
      RESOURCE_ID,
      ORGANIZATION_ID,
      expect.objectContaining({ actorKind: ActorKind.USER }),
    )
    expect((await harness.call('delete_box', INPUT)).result.structuredContent).toEqual({ accepted: true })
    expect(boxes.destroy).toHaveBeenCalledWith(
      RESOURCE_ID,
      ORGANIZATION_ID,
      expect.objectContaining({ actorKind: ActorKind.USER }),
    )
  })
  it('waits for an already-starting Box without enqueueing another start', async () => {
    fixture.boxes.findOneByIdOrName.mockResolvedValue({
      ...entity,
      desiredState: BoxDesiredState.STARTED,
      state: BoxState.STARTING,
    })
    expect((await harness.call('start_box', INPUT)).result.structuredContent.status).toBe('running')
    expect(boxes.start).not.toHaveBeenCalled()
    expect(waiter.waitForStarted).toHaveBeenCalledWith(RESOURCE_ID, ORGANIZATION_ID, 30)
  })
  it.each(['get_box', 'delete_box', 'start_box', 'stop_box'])(
    'checks organization ownership before %s effects',
    async (name) => {
      fixture.boxes.findOneByIdOrName.mockResolvedValue({ ...entity, organizationId: FOREIGN_ORGANIZATION_ID })
      expect((await harness.call(name, INPUT)).result.isError).toBe(true)
      for (const operation of Object.values(boxes)) expect(operation).not.toHaveBeenCalled()
      expect(fixture.auditService.createLog).not.toHaveBeenCalled()
    },
  )
  it('returns false equally for missing and foreign Boxes while preserving unexpected failures', async () => {
    fixture.boxes.findOneByIdOrName.mockRejectedValueOnce(new NotFoundException())
    expect((await harness.call('box_exists', INPUT)).result.structuredContent).toEqual({ exists: false })
    fixture.boxes.findOneByIdOrName.mockResolvedValueOnce({ ...entity, organizationId: FOREIGN_ORGANIZATION_ID })
    expect((await harness.call('box_exists', INPUT)).result.structuredContent).toEqual({ exists: false })
    fixture.boxes.findOneByIdOrName.mockRejectedValueOnce(new Error('private database details'))
    expect((await harness.call('box_exists', INPUT)).result.content[0].text).toBe('Tool operation failed')
  })
  it('rejects unbounded, empty and NUL-containing selectors before organization access', async () => {
    for (const box_id of ['', 'bad\0name', 'x'.repeat(513)]) {
      const body = await harness.call('get_box', { organization_id: ORGANIZATION_ID, box_id })
      expect(body.error || body.result?.isError).toBeTruthy()
    }
    expect(fixture.memberships.findOne).not.toHaveBeenCalled()
  })

  it('rejects unsupported hosted options before authorization and runs nested REST validators', async () => {
    for (const unsupported of [
      { advanced: {} },
      { rootfs_path: '/host' },
      { ports: [] },
      { tty: false },
      { detach: false },
    ]) {
      const body = await harness.call('create_box', { organization_id: ORGANIZATION_ID, ...unsupported })
      expect(body.error || body.result?.isError).toBeTruthy()
    }
    expect(fixture.memberships.findOne).not.toHaveBeenCalled()
    for (const request of [
      { network: { outbound: { mode: 'enabled', allow_net: ['invalid host name'] } } },
      { volumes: [{ managed_volume: '/host/path', guest_path: '/data' }] },
    ]) {
      expect((await harness.call('create_box', { organization_id: ORGANIZATION_ID, ...request })).result.isError).toBe(
        true,
      )
    }
    expect(boxes.create).not.toHaveBeenCalled()
  })
})
