/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { McpServer, type CallToolResult, type ServerContext } from '@modelcontextprotocol/server'
import { Logger } from '@nestjs/common'
import { BoxService } from '../../../box/services/box.service'
import { TunnelService } from '../../../box/services/tunnel.service'
import { BoxState } from '../../../box/enums/box-state.enum'
import { AuditAction } from '../../../audit/enums/audit-action.enum'
import { NetworkTools } from './network-tools'
import {
  accessFixture,
  caller,
  FOREIGN_ORGANIZATION_ID,
  ORGANIZATION_ID,
  RESOURCE_ID,
  toolHarness,
} from '../../tests/tool-harness'

const INPUT = { organization_id: ORGANIZATION_ID, box_id: '我的 Box' }
const NAMES = ['set_box_inbound', 'prepare_tunnel']

describe('MCP Box network tools', () => {
  let fixture: ReturnType<typeof accessFixture>
  let harness: Awaited<ReturnType<typeof toolHarness>>
  let boxes: { updateInboundEnabled: jest.Mock; updateLastActivityAt: jest.Mock; getNetworkTunnelUrl: jest.Mock }
  let tunnels: { declarePublic: jest.Mock }
  let tools: NetworkTools
  const box = {
    id: RESOURCE_ID,
    organizationId: ORGANIZATION_ID,
    inboundEnabled: true,
    autoResume: false,
    state: BoxState.STARTED,
  }

  beforeEach(async () => {
    fixture = accessFixture()
    fixture.boxes.findOneByIdOrName.mockResolvedValue(box)
    boxes = {
      updateInboundEnabled: jest.fn().mockResolvedValue({ ...box, inboundEnabled: false }),
      updateLastActivityAt: jest.fn().mockResolvedValue(undefined),
      getNetworkTunnelUrl: jest.fn().mockResolvedValue('https://8080-box.preview.example'),
    }
    tunnels = { declarePublic: jest.fn().mockResolvedValue(undefined) }
    tools = new NetworkTools(
      fixture.access,
      boxes as unknown as BoxService,
      tunnels as unknown as TunnelService,
      fixture.audit,
    )
    harness = await toolHarness((server) => tools.register(server, caller))
  })
  afterEach(async () => {
    await harness.close()
  })
  function args(name: string) {
    return { ...INPUT, ...(name === 'prepare_tunnel' ? { port: 8080 } : { mode: 'disabled' }) }
  }

  it('advertises strict inputs and public interaction hints', async () => {
    const { result } = await harness.list()
    expect(result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([...NAMES].sort())
    for (const tool of result.tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false)
      expect(tool.annotations.openWorldHint).toBe(true)
      expect(tool.annotations.readOnlyHint).toBe(false)
    }
  })
  it.each(NAMES)('requires membership before %s', async (name) => {
    fixture.memberships.findOne.mockResolvedValue(null)
    expect((await harness.call(name, args(name))).result.isError).toBe(true)
    expect(fixture.boxes.findOneByIdOrName).not.toHaveBeenCalled()
    for (const operation of Object.values(boxes)) expect(operation).not.toHaveBeenCalled()
    expect(tunnels.declarePublic).not.toHaveBeenCalled()
  })
  it.each(NAMES)('requires WRITE_BOXES before %s', async (name) => {
    fixture.member.assignedRoles = []
    expect((await harness.call(name, args(name))).result.isError).toBe(true)
    expect(fixture.boxes.findOneByIdOrName).not.toHaveBeenCalled()
    for (const operation of Object.values(boxes)) expect(operation).not.toHaveBeenCalled()
  })
  it.each(NAMES)('checks Box ownership before %s audit/effects', async (name) => {
    fixture.boxes.findOneByIdOrName.mockResolvedValue({ ...box, organizationId: FOREIGN_ORGANIZATION_ID })
    expect((await harness.call(name, args(name))).result.isError).toBe(true)
    for (const operation of Object.values(boxes)) expect(operation).not.toHaveBeenCalled()
    expect(tunnels.declarePublic).not.toHaveBeenCalled()
    expect(fixture.auditService.createLog).not.toHaveBeenCalled()
  })
  it('updates inbound mode with the REST DTO and existing audited action', async () => {
    const { result } = await harness.call('set_box_inbound', args('set_box_inbound'))
    expect(result.structuredContent).toEqual({ mode: 'disabled' })
    expect(boxes.updateInboundEnabled).toHaveBeenCalledWith(RESOURCE_ID, false, ORGANIZATION_ID)
    expect(fixture.auditService.createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.UPDATE_INBOUND_ACCESS,
        targetId: RESOURCE_ID,
        metadata: { tool: 'set_box_inbound' },
      }),
    )
  })
  it('records activity, prepares the service URI, then declares only the resolved internal port public', async () => {
    const { result } = await harness.call('prepare_tunnel', args('prepare_tunnel'))
    expect(result.structuredContent).toEqual({ uri: 'https://8080-box.preview.example' })
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent)
    expect(boxes.updateLastActivityAt).toHaveBeenCalledWith(RESOURCE_ID, expect.any(Date))
    expect(boxes.getNetworkTunnelUrl).toHaveBeenCalledWith(RESOURCE_ID, ORGANIZATION_ID, 8080)
    expect(tunnels.declarePublic).toHaveBeenCalledWith(RESOURCE_ID, 8080)
    expect(fixture.auditService.createLog.mock.invocationCallOrder[0]).toBeLessThan(
      boxes.updateLastActivityAt.mock.invocationCallOrder[0],
    )
    expect(boxes.updateLastActivityAt.mock.invocationCallOrder[0]).toBeLessThan(
      tunnels.declarePublic.mock.invocationCallOrder[0],
    )
  })
  it('preserves best-effort activity updates without logging backend error payloads', async () => {
    const warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    boxes.updateLastActivityAt.mockRejectedValueOnce(new Error('sensitive backend details'))
    try {
      expect((await harness.call('prepare_tunnel', args('prepare_tunnel'))).result.isError).toBeFalsy()
      expect(warning).toHaveBeenCalledWith('MCP tunnel activity update failed')
      expect(JSON.stringify(warning.mock.calls)).not.toContain('sensitive backend details')
    } finally {
      warning.mockRestore()
    }
  })

  it('refuses inbound-disabled Boxes before public declarations or activity', async () => {
    fixture.boxes.findOneByIdOrName.mockResolvedValue({ ...box, inboundEnabled: false })
    expect((await harness.call('prepare_tunnel', args('prepare_tunnel'))).result.isError).toBe(true)
    expect(boxes.updateLastActivityAt).not.toHaveBeenCalled()
    expect(tunnels.declarePublic).not.toHaveBeenCalled()
  })
  it('preserves the auto-resume readiness gate without waking a Box while preparing its URL', async () => {
    fixture.boxes.findOneByIdOrName.mockResolvedValue({ ...box, state: BoxState.STOPPED, autoResume: true })
    expect((await harness.call('prepare_tunnel', args('prepare_tunnel'))).result.isError).toBeFalsy()
    fixture.boxes.findOneByIdOrName.mockResolvedValue({ ...box, state: BoxState.STOPPED, autoResume: false })
    tunnels.declarePublic.mockClear()
    expect((await harness.call('prepare_tunnel', args('prepare_tunnel'))).result.isError).toBe(true)
    expect(tunnels.declarePublic).not.toHaveBeenCalled()
  })
  it('rejects reserved, invalid ports and unsupported inbound allowlists before authorization', async () => {
    for (const port of [0, 65536, 22222, 1.5]) {
      const body = await harness.call('prepare_tunnel', { ...INPUT, port })
      expect(body.error || body.result?.isError).toBeTruthy()
    }
    const body = await harness.call('set_box_inbound', { ...INPUT, mode: 'enabled', allow_net: ['example.com'] })
    expect(body.error || body.result?.isError).toBeTruthy()
    expect(fixture.memberships.findOne).not.toHaveBeenCalled()
  })
  it.each(['activity', 'uri'])(
    'does not declare a new public tunnel when cancelled while awaiting %s',
    async (phase) => {
      const entered = deferred<void>()
      const gate = deferred<void>()
      if (phase === 'activity')
        boxes.updateLastActivityAt.mockImplementationOnce(async () => {
          entered.resolve()
          await gate.promise
        })
      else
        boxes.getNetworkTunnelUrl.mockImplementationOnce(async () => {
          entered.resolve()
          await gate.promise
          return 'https://8080-box.preview.example'
        })
      const server = new McpServer({ name: 'cancellation-test', version: '0' })
      const registrations = jest.spyOn(server, 'registerTool')
      tools.register(server, caller)
      const registration = registrations.mock.calls.find(([name]) => name === 'prepare_tunnel')
      if (!registration) throw new Error('Tunnel tool was not registered')
      const invoke = registration[2] as (
        input: Record<string, unknown>,
        context: ServerContext,
      ) => Promise<CallToolResult>
      const controller = new AbortController()
      const pending = invoke(args('prepare_tunnel'), { mcpReq: { signal: controller.signal } } as ServerContext)
      await entered.promise
      controller.abort()
      gate.resolve()
      const result = await pending
      expect(result.isError).toBe(true)
      expect(result.content[0]).toEqual({
        type: 'text',
        text: 'Tool call cancelled; Box activity may already have been recorded',
      })
      expect(tunnels.declarePublic).not.toHaveBeenCalled()
    },
  )
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}
