/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { getEventListeners } from 'node:events'
import { NotFoundException, RequestTimeoutException } from '@nestjs/common'
import WebSocket from 'isomorphic-ws'
import type { BoxService } from '../../../box/services/box.service'
import type { RunnerService } from '../../../box/services/runner.service'
import type { BoxAutoResumeService } from '../../../box/services/box-auto-resume.service'
import type { OrganizationAuthContext } from '../../../common/interfaces/auth-context.interface'
import { McpRunnerWebSocket } from '../../runner/runner-websocket'
import { McpExecutionOutputTools } from './execution-output-tools'
import { accessFixture, caller, ORGANIZATION_ID, FOREIGN_ORGANIZATION_ID, toolHarness } from '../../tests/tool-harness'

describe('MCP execution output through real WebSocket attach', () => {
  let http: Server
  let ws: WebSocket.Server
  let origin: string
  let mcp: Awaited<ReturnType<typeof toolHarness>>
  let fixture: ReturnType<typeof accessFixture>
  let box: { id: string; organizationId: string; runnerId: string; autoResume: boolean; autoStop: number }
  let boxes: { findOneByIdOrName: jest.Mock; updateLastActivityAt: jest.Mock }
  let runners: { findOne: jest.Mock }
  let resume: { ensureReady: jest.Mock }
  let transport: McpRunnerWebSocket
  let attach: (socket: WebSocket) => void
  let upgrade: ((request: IncomingMessage, socket: Socket, head: Buffer) => void) | undefined
  let socketClosed: Promise<void>
  const upgrades: { path: string; authorization: string; extensions: string | undefined }[] = []
  const applicationFrames: unknown[] = []
  const sockets = new Set<Socket>()
  const scope = { organization_id: ORGANIZATION_ID, box_id: 'Box with spaces', execution_id: 'exec-1' }

  beforeAll(async () => {
    http = createServer((_, response) => response.writeHead(404).end())
    ws = new WebSocket.Server({ noServer: true, perMessageDeflate: false })
    http.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    http.on('upgrade', (request, socket: Socket, head) => {
      socketClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
      upgrades.push({
        path: request.url,
        authorization: request.headers.authorization,
        extensions: request.headers['sec-websocket-extensions'],
      })
      if (upgrade) {
        // Raw upgraded sockets can remain half-open; acknowledge client EOF so close is observable.
        socket.once('end', () => socket.end())
        upgrade(request, socket, head)
      } else
        ws.handleUpgrade(request, socket, head, (client) => {
          client.on('error', () => undefined)
          client.on('message', (frame) => applicationFrames.push(frame))
          attach(client)
        })
    })
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
    mcp = await toolHarness((server) => new McpExecutionOutputTools(fixture.access, transport).register(server, caller))
  })

  beforeEach(() => {
    upgrades.length = 0
    applicationFrames.length = 0
    upgrade = undefined
    fixture = accessFixture()
    box = { id: 'internal-box', organizationId: ORGANIZATION_ID, runnerId: 'runner-1', autoResume: false, autoStop: 0 }
    fixture.boxes.findOneByIdOrName.mockResolvedValue(box)
    boxes = { ...fixture.boxes, updateLastActivityAt: jest.fn().mockResolvedValue(undefined) }
    runners = {
      findOne: jest
        .fn()
        .mockResolvedValue({ apiUrl: `${origin}/prefix?discard=private-marker#discard`, apiKey: 'runner-secret' }),
    }
    resume = { ensureReady: jest.fn().mockResolvedValue(undefined) }
    transport = new McpRunnerWebSocket(
      boxes as unknown as BoxService,
      runners as unknown as RunnerService,
      resume as unknown as BoxAutoResumeService,
    )
    attach = (client) => {
      client.send(Buffer.from([1, ...Buffer.from('hello')]))
      client.send(Buffer.from([2, ...Buffer.from('warning')]))
      client.send(JSON.stringify({ type: 'exit', exit_code: 7 }))
    }
  })

  afterEach(() => {
    for (const client of ws.clients) client.terminate()
    for (const socket of sockets) socket.destroy()
  })

  afterAll(async () => {
    await mcp.close()
    await new Promise<void>((resolve) => ws.close(() => resolve()))
    await new Promise<void>((resolve) => http.close(() => resolve()))
  })

  function auth(): OrganizationAuthContext {
    return { ...caller, organizationId: ORGANIZATION_ID, organization: fixture.organization } as OrganizationAuthContext
  }

  function capture(signal?: AbortSignal, maxBytes = 32768) {
    return transport.capture(auth(), scope.box_id, scope.execution_id, { maxBytes, waitSeconds: 1 }, signal)
  }

  it('returns real multiplexed output through MCP and uses only trusted routing credentials', async () => {
    const body = await mcp.call('get_execution_output', scope)
    expect(body.result.isError).toBeUndefined()
    expect(body.result.structuredContent).toEqual({
      execution_id: 'exec-1',
      stdout: 'hello',
      stderr: 'warning',
      stop_reason: 'exit',
      exit_code: 7,
      limit_reached: false,
      history_complete: 'unknown',
    })
    expect(JSON.parse(body.result.content[0].text)).toEqual(body.result.structuredContent)
    expect(upgrades).toEqual([
      {
        path: '/prefix/v1/boxes/internal-box/executions/exec-1/attach',
        authorization: 'Bearer runner-secret',
        extensions: undefined,
      },
    ])
    expect(boxes.findOneByIdOrName).toHaveBeenCalledWith(scope.box_id, ORGANIZATION_ID)
    expect(boxes.updateLastActivityAt).toHaveBeenCalledWith('internal-box', expect.any(Date))
    expect(applicationFrames).toEqual([])
    await socketClosed
    expect(sockets.size).toBe(0)
    expect(JSON.stringify(body)).not.toContain('runner-secret')
  })

  it('advertises bounded arguments and lifecycle effects without a pagination or completeness promise', async () => {
    const body = await mcp.list()
    expect(body.result.tools).toHaveLength(1)
    const tool = body.result.tools[0]
    expect(tool.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: false })
    expect(tool.description).toContain('signaled and terminated')
    expect(tool.description).toContain('not pagination')
    expect(tool.inputSchema.properties.max_bytes).toEqual(expect.objectContaining({ maximum: 65536, default: 32768 }))
    expect(tool.inputSchema.properties.wait_seconds).toEqual(
      expect.objectContaining({ minimum: 1, maximum: 15, default: 2 }),
    )
    expect(tool.inputSchema.properties).not.toHaveProperty('cursor')
    expect(upgrades).toHaveLength(0)
  })

  it('decodes per-stream UTF-8 only after joining bytes across frames', async () => {
    const stdout = Buffer.from('A\u20acB')
    const stderr = Buffer.from('x\ud83d\ude80y')
    attach = (client) => {
      client.send(Buffer.concat([Buffer.from([1]), stdout.subarray(0, 2)]))
      client.send(Buffer.concat([Buffer.from([2]), stderr.subarray(0, 3)]))
      client.send(Buffer.concat([Buffer.from([1]), stdout.subarray(2)]))
      client.send(Buffer.concat([Buffer.from([2]), stderr.subarray(3)]))
      client.send(JSON.stringify({ type: 'exit', exit_code: 0 }))
    }
    const body = await mcp.call('get_execution_output', scope)
    expect(body.result.structuredContent).toEqual(
      expect.objectContaining({ stdout: 'A\u20acB', stderr: 'x\ud83d\ude80y', exit_code: 0 }),
    )
  })

  it('caps the combined raw byte budget while keeping historical completeness unknown', async () => {
    const body = await mcp.call('get_execution_output', { ...scope, max_bytes: 8 })
    expect(body.result.structuredContent).toEqual({
      execution_id: 'exec-1',
      stdout: 'hello',
      stderr: 'war',
      stop_reason: 'byte_limit',
      exit_code: null,
      limit_reached: true,
      history_complete: 'unknown',
    })
    expect(applicationFrames).toEqual([])
  })

  it('reports exactly reaching the budget without claiming that a later exit frame was observed', async () => {
    const result = await capture(undefined, 5)
    expect(result).toEqual(
      expect.objectContaining({
        stdout: 'hello',
        stderr: '',
        stop_reason: 'byte_limit',
        limit_reached: true,
        exit_code: null,
      }),
    )
  })

  it('bounds raw bytes rather than the encoded size of replacement text', async () => {
    attach = (client) => client.send(Buffer.from([1, 255, 255, 255]))
    const result = await capture(undefined, 2)
    expect(result.stdout).toBe('\ufffd\ufffd')
    expect(Buffer.byteLength(result.stdout)).toBe(6)
    expect(result.limit_reached).toBe(true)
  })

  it('returns a bounded capture deadline without pretending the execution exited', async () => {
    attach = (client) => client.send(Buffer.from([1, 65]))
    const result = await capture()
    expect(result).toEqual(
      expect.objectContaining({ stdout: 'A', stop_reason: 'time_limit', exit_code: null, history_complete: 'unknown' }),
    )
    expect(applicationFrames).toHaveLength(0)
  })

  it('treats stdout-only TTY-style output as merged data without inventing stderr', async () => {
    attach = (client) => {
      client.send(Buffer.from([1, ...Buffer.from('merged output')]))
      client.send(JSON.stringify({ type: 'exit', exit_code: 0 }))
    }
    const result = await capture()
    expect(result.stdout).toBe('merged output')
    expect(result.stderr).toBe('')
    expect(result.history_complete).toBe('unknown')
  })

  it.each([
    '{',
    '[]',
    '{"type":"error","message":"private-marker"}',
    '{"type":"exit","exit_code":"0"}',
    '{"type":"exit","exit_code":0,"secret":"private-marker"}',
    '{"type":"exit","exit_code":9007199254740992}',
    '{"type":"lag","dropped":1}',
  ])('sanitizes unsupported control frames: %s', async (frame) => {
    attach = (client) => client.send(frame)
    const body = await mcp.call('get_execution_output', scope)
    expect(body.result.isError).toBe(true)
    expect(body.result.structuredContent.error).toEqual(
      expect.objectContaining({ source: 'runner', operation: 'get_execution_output', code: 'invalid_response' }),
    )
    expect(JSON.stringify(body)).not.toContain('private-marker')
    expect(applicationFrames).toHaveLength(0)
  })

  it.each([Buffer.alloc(0), Buffer.from([0, 65]), Buffer.from([3, 65])])(
    'rejects an invalid output channel',
    async (frame) => {
      attach = (client) => client.send(frame)
      await expect(capture()).rejects.toMatchObject({ failure: { source: 'runner', code: 'invalid_response' } })
    },
  )

  it('rejects an oversized WebSocket message before collecting it', async () => {
    attach = (client) => client.send(Buffer.alloc(256 * 1024 + 2, 1))
    await expect(capture()).rejects.toMatchObject({ failure: { source: 'runner', code: 'resource_exhausted' } })
    expect(upgrades).toHaveLength(1)
  })

  it('accepts a full Runner replay frame while retaining only the maximum capture budget', async () => {
    attach = (client) => {
      const replay = Buffer.alloc(256 * 1024 + 1, 65)
      replay[0] = 1
      client.send(replay)
    }
    const body = await mcp.call('get_execution_output', { ...scope, max_bytes: 65536 })
    const result = body.result.structuredContent
    expect(result.stdout).toHaveLength(65536)
    expect(result.stderr).toBe('')
    expect(result.stop_reason).toBe('byte_limit')
    expect(result.limit_reached).toBe(true)
    expect(result.history_complete).toBe('unknown')
  })

  it('does not equate a normal socket close with execution completion', async () => {
    attach = (client) => client.close(1000)
    await expect(capture()).rejects.toMatchObject({ failure: { source: 'runner', code: 'interrupted' } })
  })

  it('sanitizes abnormal disconnects without replaying an execution', async () => {
    attach = (client) => client.terminate()
    await expect(capture()).rejects.toMatchObject({ failure: { source: 'runner', code: 'interrupted' } })
    expect(upgrades).toHaveLength(1)
    expect(applicationFrames).toHaveLength(0)
  })

  it.each([404, 409, 500, 302])('aborts a refused %s upgrade even when its error body never ends', async (status) => {
    let closed: Promise<void>
    upgrade = (_, socket) => {
      closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
      socket.write(
        `HTTP/1.1 ${status} Rejected\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\nLocation: ${origin}/untrusted\r\n\r\n`,
      )
      socket.write('e\r\nprivate-marker\r\n')
      socket.resume()
    }
    const body = await mcp.call('get_execution_output', scope)
    expect(body.result.isError).toBe(true)
    expect(body.result.structuredContent.error).toEqual(
      expect.objectContaining({
        source: 'runner',
        status,
        code: status === 409 ? 'conflict' : status === 404 ? 'not_found' : 'upstream_error',
      }),
    )
    expect(JSON.stringify(body)).not.toContain('private-marker')
    await closed
    expect(upgrades).toHaveLength(1)
  })

  it('cancels before service preparation without making a connection', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(capture(abort.signal)).rejects.toMatchObject({ failure: { source: 'mcp', code: 'cancelled' } })
    expect(boxes.findOneByIdOrName).not.toHaveBeenCalled()
    expect(upgrades).toHaveLength(0)
  })

  it('cancels a pending handshake and closes the underlying connection', async () => {
    const abort = new AbortController()
    let closed: Promise<void>
    upgrade = (_, socket) => {
      closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
      socket.resume()
      abort.abort()
    }
    await expect(capture(abort.signal)).rejects.toMatchObject({ failure: { source: 'mcp', code: 'cancelled' } })
    await closed
    expect(upgrades).toHaveLength(1)
  })

  it('cancels capture after upgrade without sending stdin or process controls', async () => {
    const abort = new AbortController()
    attach = (client) => {
      client.once('pong', () => abort.abort())
      client.ping()
    }
    await expect(capture(abort.signal)).rejects.toMatchObject({ failure: { source: 'mcp', code: 'cancelled' } })
    expect(applicationFrames).toEqual([])
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0)
  })

  it('bounds a silent handshake without a retry', async () => {
    upgrade = (_, socket) => socket.resume()
    await expect(capture()).rejects.toMatchObject({ failure: { source: 'runner', code: 'interrupted' } })
    await socketClosed
    expect(upgrades).toHaveLength(1)
  }, 7_000)

  it('releases cancellation listeners after repeated completed captures', async () => {
    const abort = new AbortController()
    await capture(abort.signal)
    await capture(abort.signal)
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0)
  })

  it('bounds graceful close when the peer stops reading', async () => {
    attach = (client) => {
      client.send(Buffer.from([1, 65]))
      client.pause()
    }
    const result = await capture(undefined, 1)
    expect(result.stop_reason).toBe('byte_limit')
    expect(result.stdout).toBe('A')
  })

  it('preserves a service readiness timeout and unknown lifecycle outcome before any upgrade', async () => {
    box.autoResume = true
    resume.ensureReady.mockRejectedValue(new RequestTimeoutException('Box readiness timed out'))
    const body = await mcp.call('get_execution_output', scope)
    expect(body.result.structuredContent.error).toEqual(
      expect.objectContaining({ source: 'service', status: 408, code: 'timeout', outcome: 'unknown' }),
    )
    expect(body.result.structuredContent.error.message).toContain('Box readiness timed out')
    expect(upgrades).toHaveLength(0)
  })

  it('cancels a pending resume wait without claiming the lifecycle operation was revoked', async () => {
    box.autoResume = true
    const abort = new AbortController()
    let began: () => void
    const started = new Promise<void>((resolve) => {
      began = resolve
    })
    resume.ensureReady.mockImplementation(() => {
      began()
      return new Promise<void>(() => undefined)
    })
    const pending = capture(abort.signal)
    await started
    abort.abort()
    await expect(pending).rejects.toMatchObject({ failure: { source: 'mcp', code: 'cancelled', outcome: 'unknown' } })
    expect(upgrades).toHaveLength(0)
  })

  it.each(['foreign organization', 'missing write permission', 'foreign box', 'missing box'])(
    'denies %s before upgrading',
    async (denial) => {
      const args = { ...scope }
      if (denial === 'foreign organization') {
        args.organization_id = FOREIGN_ORGANIZATION_ID
        fixture.memberships.findOne.mockResolvedValue(null)
      } else if (denial === 'missing write permission') fixture.member.assignedRoles = []
      else if (denial === 'foreign box') box.organizationId = FOREIGN_ORGANIZATION_ID
      else boxes.findOneByIdOrName.mockRejectedValue(new NotFoundException('private-marker'))
      const body = await mcp.call('get_execution_output', args)
      expect(body.result.isError).toBe(true)
      expect(JSON.stringify(body)).not.toContain('private-marker')
      expect(upgrades).toHaveLength(0)
    },
  )

  it.each(['not a URL private-marker', 'file:///private-marker', 'http://private-marker:secret@localhost'])(
    'rejects an untrusted Runner endpoint: %s',
    async (apiUrl) => {
      runners.findOne.mockResolvedValue({ apiUrl, apiKey: 'runner-secret' })
      const body = await mcp.call('get_execution_output', scope)
      expect(body.result.structuredContent.error).toEqual(
        expect.objectContaining({ source: 'runner', code: 'upstream_unavailable' }),
      )
      expect(JSON.stringify(body)).not.toContain('private-marker')
      expect(upgrades).toHaveLength(0)
    },
  )

  it.each([
    { execution_id: '../escape' },
    { execution_id: '.' },
    { max_bytes: 0 },
    { max_bytes: 65537 },
    { wait_seconds: 16 },
    { cursor: 'invented' },
    { url: 'http://untrusted.test' },
  ])('rejects unsupported or oversized tool arguments before service calls', async (input) => {
    const body = await mcp.call('get_execution_output', { ...scope, ...input })
    expect(body.result.isError).toBe(true)
    expect(boxes.findOneByIdOrName).not.toHaveBeenCalled()
    expect(upgrades).toHaveLength(0)
  })
})
