/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { BoxService } from '../../../box/services/box.service'
import type { RunnerService } from '../../../box/services/runner.service'
import type { BoxAutoResumeService } from '../../../box/services/box-auto-resume.service'
import { McpExecutionTools } from './execution-tools'
import { McpRunnerHttp } from '../../runner/runner-http'
import { accessFixture, caller, ORGANIZATION_ID, FOREIGN_ORGANIZATION_ID, toolHarness } from '../../tests/tool-harness'

describe('McpExecutionTools HTTP calls', () => {
  let http: Server
  let origin: string
  let fixture: ReturnType<typeof accessFixture>
  let tools: McpExecutionTools
  let mcp: Awaited<ReturnType<typeof toolHarness>>
  let respond: (response: ServerResponse) => void
  let requests: { method: string; url: string; authorization: string; body: Buffer }[]
  const scope = { organization_id: ORGANIZATION_ID, box_id: 'my box' }

  beforeAll(async () => {
    http = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks),
      })
      respond(response)
    })
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
    mcp = await toolHarness((server) => tools.register(server, caller))
  })

  afterAll(async () => {
    await mcp.close()
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  })

  beforeEach(() => {
    requests = []
    fixture = accessFixture()
    fixture.boxes.findOneByIdOrName.mockResolvedValue({
      id: 'internal-box',
      organizationId: ORGANIZATION_ID,
      runnerId: 'runner-1',
      autoResume: false,
      autoStop: 0,
    })
    const boxes = { ...fixture.boxes, updateLastActivityAt: jest.fn().mockResolvedValue(undefined) }
    const runner = new McpRunnerHttp(
      boxes as unknown as BoxService,
      { findOne: jest.fn().mockResolvedValue({ apiUrl: origin, apiKey: 'runner-secret' }) } as unknown as RunnerService,
      { ensureReady: jest.fn() } as unknown as BoxAutoResumeService,
    )
    tools = new McpExecutionTools(fixture.access, runner)
    respond = (response) => response.end(JSON.stringify({ execution_id: 'exec-1' }))
  })

  it('advertises exactly the five implemented execution operations with lifecycle-aware annotations', async () => {
    const body = await mcp.list()
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      'exec_box',
      'get_execution',
      'kill_execution',
      'signal_execution',
      'resize_execution',
    ])
    expect(body.result.tools.every((tool) => tool.annotations.readOnlyHint === false)).toBe(true)
    expect(body.result.tools.find((tool) => tool.name === 'exec_box').annotations.destructiveHint).toBe(true)
    expect(body.result.tools.find((tool) => tool.name === 'exec_box').annotations.openWorldHint).toBe(true)
    expect(body.result.tools.find((tool) => tool.name === 'resize_execution').annotations.destructiveHint).toBe(false)
  })

  it('starts asynchronous exec through the scoped adapter and projects the advertised response', async () => {
    respond = (response) => response.end(JSON.stringify({ execution_id: 'exec-1', secret: 'not-public' }))
    const input = {
      command: 'sh',
      args: ['-c', 'echo hi'],
      env: { LANG: 'C' },
      working_dir: '/tmp',
      timeout_seconds: 2,
      tty: true,
    }
    const body = await mcp.call('exec_box', { ...scope, ...input })
    expect(body.result.structuredContent).toEqual({ execution_id: 'exec-1' })
    expect(JSON.parse(body.result.content[0].text)).toEqual(body.result.structuredContent)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: '/v1/boxes/internal-box/exec',
      authorization: 'Bearer runner-secret',
    })
    expect(JSON.parse(requests[0].body.toString())).toEqual(input)
  })

  it('returns real status and a zero exit code without inventing stdout or timing', async () => {
    respond = (response) =>
      response.end(
        JSON.stringify({ execution_id: 'exec-1', status: 'completed', exit_code: 0, stdout: 'not implemented' }),
      )
    const body = await mcp.call('get_execution', { ...scope, execution_id: 'exec-1' })
    expect(body.result.structuredContent).toEqual({ execution_id: 'exec-1', status: 'completed', exit_code: 0 })
    expect(requests[0].method).toBe('GET')
  })

  it.each([
    ['kill_execution', {}, 'DELETE', '/executions/exec-1', undefined],
    ['signal_execution', { signal: 15 }, 'POST', '/executions/exec-1/signal', { signal: 15 }],
    ['resize_execution', { rows: 40, cols: 120 }, 'POST', '/executions/exec-1/resize', { rows: 40, cols: 120 }],
  ])('maps %s to the implemented Runner request', async (name, extra, method, path, expected) => {
    respond = (response) => {
      response.writeHead(204)
      response.end()
    }
    const body = await mcp.call(name, { ...scope, execution_id: 'exec-1', ...extra })
    expect(body.result.structuredContent).toEqual({ completed: true })
    expect(requests[0]).toMatchObject({ method, url: `/v1/boxes/internal-box${path}` })
    expect(requests[0].body.length ? JSON.parse(requests[0].body.toString()) : undefined).toEqual(expected)
  })

  it.each([1, 2, 3, 6, 10, 12, 15, 28])('accepts actual Runner signal %s', async (signal) => {
    respond = (response) => {
      response.writeHead(204)
      response.end()
    }
    const body = await mcp.call('signal_execution', { ...scope, execution_id: 'exec-1', signal })
    expect(body.result.isError).toBeFalsy()
    expect(JSON.parse(requests[0].body.toString())).toEqual({ signal })
  })

  it.each([
    ['signal_execution', { execution_id: 'exec-1', signal: 9 }],
    ['signal_execution', { execution_id: 'exec-1', signal: 19 }],
    ['resize_execution', { execution_id: 'exec-1', rows: 0, cols: 10 }],
    ['resize_execution', { execution_id: 'exec-1', rows: 1, cols: 0x1_0000_0000 }],
    ['get_execution', { execution_id: '..' }],
    ['exec_box', { command: 'true', timeout_seconds: 0 }],
    ['exec_box', { command: 'true', env: { 'BAD=KEY': 'x' } }],
    ['exec_box', { command: 'true', attach: true }],
  ])('rejects unsupported or invalid %s input before authorization and network', async (name, args) => {
    const body = await mcp.call(name, { ...scope, ...args })
    expect(body.error ?? body.result.isError).toBeTruthy()
    expect(fixture.memberships.findOne).not.toHaveBeenCalled()
    expect(requests).toHaveLength(0)
  })

  it('requires write permission for exec while status follows membership-only REST access', async () => {
    fixture.member.assignedRoles = []
    const denied = await mcp.call('exec_box', { ...scope, command: 'true' })
    expect(denied.result.isError).toBe(true)
    expect(requests).toHaveLength(0)
    respond = (response) => response.end(JSON.stringify({ execution_id: 'exec-1', status: 'running' }))
    expect((await mcp.call('get_execution', { ...scope, execution_id: 'exec-1' })).result.structuredContent).toEqual({
      execution_id: 'exec-1',
      status: 'running',
    })
  })

  it('denies non-members and foreign Boxes before any Runner request', async () => {
    fixture.memberships.findOne.mockResolvedValueOnce(null)
    expect(
      (await mcp.call('exec_box', { ...scope, organization_id: FOREIGN_ORGANIZATION_ID, command: 'true' })).result
        .isError,
    ).toBe(true)
    fixture.boxes.findOneByIdOrName.mockResolvedValueOnce({
      id: 'internal-box',
      organizationId: FOREIGN_ORGANIZATION_ID,
    })
    expect((await mcp.call('exec_box', { ...scope, command: 'true' })).result.isError).toBe(true)
    expect(requests).toHaveLength(0)
  })

  it.each(['not-json runner-secret', '{"unexpected":"runner-secret"}'])(
    'reports uncertain exec effects for an invalid response without exposing payloads',
    async (payload) => {
      respond = (response) => response.end(payload)
      const body = await mcp.call('exec_box', { ...scope, command: 'true' })
      expect(body.result.isError).toBe(true)
      expect(body.result.content[0].text).toContain('may have started')
      expect(JSON.stringify(body)).not.toContain('runner-secret')
      expect(body.result.structuredContent.error.source).toBe('runner')
      expect(requests).toHaveLength(1)
    },
  )
})
