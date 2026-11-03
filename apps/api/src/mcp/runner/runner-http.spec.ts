/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { NotFoundException } from '@nestjs/common'
import type { AddressInfo } from 'node:net'
import type { BoxService } from '../../box/services/box.service'
import type { RunnerService } from '../../box/services/runner.service'
import type { BoxAutoResumeService } from '../../box/services/box-auto-resume.service'
import type { OrganizationAuthContext } from '../../common/interfaces/auth-context.interface'
import { McpRunnerHttp, RUNNER_ARCHIVE_LIMIT, RUNNER_JSON_LIMIT, type RunnerOperation } from './runner-http'

const AUTH = {
  organizationId: 'org-1',
  organization: { id: 'org-1' },
  apiKey: { key: 'mcp-secret' },
} as unknown as OrganizationAuthContext

describe('McpRunnerHttp real HTTP boundary', () => {
  let server: Server
  let origin: string
  let adapter: McpRunnerHttp
  let handle: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void
  let calls: { method: string; url: string; authorization: string; body: Buffer }[]
  let box: { id: string; organizationId: string; runnerId: string; autoResume: boolean; autoStop: number }
  let boxes: { findOneByIdOrName: jest.Mock; updateLastActivityAt: jest.Mock }
  let runners: { findOne: jest.Mock }
  let resume: { ensureReady: jest.Mock }

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks)
      calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body })
      handle(req, res, body)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(() => {
    calls = []
    box = { id: 'internal-box', organizationId: 'org-1', runnerId: 'runner-1', autoResume: true, autoStop: 0 }
    boxes = {
      findOneByIdOrName: jest.fn().mockResolvedValue(box),
      updateLastActivityAt: jest.fn().mockResolvedValue(undefined),
    }
    runners = { findOne: jest.fn().mockResolvedValue({ apiUrl: origin, apiKey: 'runner-secret' }) }
    resume = { ensureReady: jest.fn().mockResolvedValue(undefined) }
    adapter = new McpRunnerHttp(
      boxes as unknown as BoxService,
      runners as unknown as RunnerService,
      resume as unknown as BoxAutoResumeService,
    )
    handle = (_req, res) => res.end('{}')
  })

  afterEach(() => jest.restoreAllMocks())

  it.each<[RunnerOperation, string, string, unknown]>([
    [
      { kind: 'exec', input: { command: 'echo', args: ['hi'], env: { MODE: 'test' }, tty: false } },
      'POST',
      '/exec',
      { command: 'echo', args: ['hi'], env: { MODE: 'test' }, tty: false },
    ],
    [{ kind: 'status', executionId: 'exec-1' }, 'GET', '/executions/exec-1', undefined],
    [{ kind: 'kill', executionId: 'exec-1' }, 'DELETE', '/executions/exec-1', undefined],
    [{ kind: 'signal', executionId: 'exec-1', signal: 15 }, 'POST', '/executions/exec-1/signal', { signal: 15 }],
    [
      { kind: 'resize', executionId: 'exec-1', rows: 40, cols: 120 },
      'POST',
      '/executions/exec-1/resize',
      { rows: 40, cols: 120 },
    ],
  ])('routes %j with the stored Runner credential', async (operation, method, path, body) => {
    await adapter.execute(AUTH, 'public-name', operation)
    expect(boxes.findOneByIdOrName).toHaveBeenCalledWith('public-name', 'org-1')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      method,
      url: `/v1/boxes/internal-box${path}`,
      authorization: 'Bearer runner-secret',
      body: expect.any(Buffer),
    })
    expect(calls[0].body.length ? JSON.parse(calls[0].body.toString()) : undefined).toEqual(body)
    expect(boxes.updateLastActivityAt).toHaveBeenCalledWith('internal-box', expect.any(Date))
    expect(resume.ensureReady).toHaveBeenCalledWith('internal-box', AUTH.organization)
  })

  it('transfers exact tar bytes with encoded query parameters and preserves source-kind hints', async () => {
    const archive = Buffer.from([0, 1, 2, 255])
    handle = (_req, res, body) => {
      res.setHeader('x-boxlite-source-is-dir', 'false')
      res.end(body)
    }
    const reply = await adapter.execute(AUTH, 'name', {
      kind: 'upload',
      path: '/tmp/a?x=1&y=2',
      archive,
      sourceIsDirectory: false,
    })
    expect(calls[0].method).toBe('PUT')
    const url = new URL(calls[0].url, origin)
    expect(url.pathname).toBe('/v1/boxes/internal-box/files')
    expect([...url.searchParams]).toEqual([
      ['path', '/tmp/a?x=1&y=2'],
      ['source_is_dir', 'false'],
    ])
    expect(reply).toEqual({ body: archive, sourceIsDirectory: false })
    await adapter.execute(AUTH, 'name', { kind: 'download', path: '/tmp/dir/.' })
    expect(calls[1].method).toBe('GET')
    expect(new URL(calls[1].url, origin).searchParams.get('path')).toBe('/tmp/dir/.')
  })

  it('keeps unknown source shape unknown and metrics observation-only', async () => {
    expect(await adapter.execute(AUTH, 'name', { kind: 'metrics' })).toEqual({ body: Buffer.from('{}') })
    expect(calls[0].url).toBe('/v1/boxes/internal-box/metrics')
    expect(boxes.updateLastActivityAt).not.toHaveBeenCalled()
    expect(resume.ensureReady).not.toHaveBeenCalled()
  })

  it('preserves the trusted Runner URL prefix when appending the fixed route', async () => {
    runners.findOne.mockResolvedValue({ apiUrl: `${origin}/runner-gateway/assigned/`, apiKey: 'runner-secret' })
    await adapter.execute(AUTH, 'name', { kind: 'metrics' })
    expect(calls[0]).toMatchObject({
      url: '/runner-gateway/assigned/v1/boxes/internal-box/metrics',
      authorization: 'Bearer runner-secret',
    })
  })

  it('refreshes activity while an HTTP operation remains pending', async () => {
    box.autoStop = 0.02
    let beat: () => void
    const heartbeat = new Promise<void>((resolve) => {
      beat = resolve
    })
    boxes.updateLastActivityAt.mockImplementation(async () => {
      if (boxes.updateLastActivityAt.mock.calls.length > 1) beat()
    })
    handle = async (_req, res) => {
      await heartbeat
      res.end('{}')
    }
    await adapter.execute(AUTH, 'name', { kind: 'status', executionId: 'exec-1' })
    expect(boxes.updateLastActivityAt.mock.calls.length).toBeGreaterThan(1)
  })

  it('denies foreign ownership before Runner lookup or network', async () => {
    box.organizationId = 'foreign'
    await expect(adapter.execute(AUTH, 'name', { kind: 'metrics' })).rejects.toThrow('Box not found or not accessible')
    expect(runners.findOne).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it.each(['my box', 'caf\u00e9'])(
    'resolves public Box name %s without putting it in the Runner path',
    async (name) => {
      await adapter.execute(AUTH, name, { kind: 'metrics' })
      expect(boxes.findOneByIdOrName).toHaveBeenCalledWith(name, 'org-1')
      expect(calls[0].url).toBe('/v1/boxes/internal-box/metrics')
    },
  )

  it('uses the same denial for missing and foreign Boxes', async () => {
    boxes.findOneByIdOrName.mockRejectedValue(new NotFoundException('private lookup details'))
    await expect(adapter.execute(AUTH, 'name', { kind: 'metrics' })).rejects.toThrow('Box not found or not accessible')
    expect(runners.findOne).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('reports lookup infrastructure failures as unavailable without leaking their cause', async () => {
    boxes.findOneByIdOrName.mockRejectedValue(new Error('runner-secret private database details'))
    await expect(adapter.execute(AUTH, 'name', { kind: 'metrics' })).rejects.toThrow(
      'Runner metrics unavailable or interrupted',
    )
    expect(runners.findOne).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('never resumes or dispatches after cancellation during initial activity', async () => {
    const controller = new AbortController()
    boxes.updateLastActivityAt.mockImplementation(async () => controller.abort())
    await expect(
      adapter.execute(AUTH, 'name', { kind: 'exec', input: { command: 'true' } }, controller.signal),
    ).rejects.toThrow('cancelled before dispatch')
    expect(resume.ensureReady).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('reports uncertain effects when an exec response exceeds its bound', async () => {
    handle = (_req, res) => res.end(Buffer.alloc(RUNNER_JSON_LIMIT + 1))
    await expect(adapter.execute(AUTH, 'name', { kind: 'exec', input: { command: 'true' } })).rejects.toThrow(
      'may have started',
    )
    expect(calls).toHaveLength(1)
  })

  it.each(['.', '..', '../metrics', 'x/y', 'x\\y', '%2e%2e', 'x?y'])(
    'rejects unsafe route identifier %s before network',
    async (executionId) => {
      await expect(adapter.execute(AUTH, 'name', { kind: 'status', executionId })).rejects.toThrow(
        'Invalid Box or execution identifier',
      )
      expect(calls).toHaveLength(0)
    },
  )

  it('rejects unsafe stored internal IDs and oversized upload/request bodies before dispatch', async () => {
    box.id = '..'
    await expect(adapter.execute(AUTH, 'name', { kind: 'metrics' })).rejects.toThrow(
      'Invalid Box or execution identifier',
    )
    await expect(
      adapter.execute(AUTH, 'name', {
        kind: 'upload',
        path: '/tmp/a',
        archive: Buffer.alloc(RUNNER_ARCHIVE_LIMIT + 1),
      }),
    ).rejects.toThrow('Archive exceeds')
    await expect(
      adapter.execute(AUTH, 'name', { kind: 'exec', input: { command: 'x'.repeat(RUNNER_JSON_LIMIT) } }),
    ).rejects.toThrow('request exceeds')
    expect(calls).toHaveLength(0)
  })

  it('returns only status for Runner errors and never follows redirects', async () => {
    handle = (_req, res) => {
      res.writeHead(409)
      res.end('runner-secret mcp-secret')
    }
    await expect(adapter.execute(AUTH, 'name', { kind: 'exec', input: { command: 'true' } })).rejects.toThrow(
      'Runner exec failed (HTTP 409)',
    )
    handle = (_req, res) => {
      res.writeHead(302, { location: `${origin}/stolen` })
      res.end()
    }
    await expect(adapter.execute(AUTH, 'name', { kind: 'metrics' })).rejects.toThrow('unavailable or interrupted')
    expect(calls).toHaveLength(2)
  })

  it.each([
    ['metrics', RUNNER_JSON_LIMIT],
    ['download', RUNNER_ARCHIVE_LIMIT],
  ] as const)('rejects oversized %s response bytes', async (kind, limit) => {
    handle = (_req, res) => res.end(Buffer.alloc(limit + 1))
    const operation: RunnerOperation = kind === 'download' ? { kind, path: '/tmp/file' } : { kind }
    await expect(adapter.execute(AUTH, 'name', operation)).rejects.toThrow(`response exceeds ${limit / 1024} KiB`)
  })

  it('cleans heartbeat on cancellation while reading and reports an ambiguous write once', async () => {
    box.autoStop = 0.02
    const controller = new AbortController()
    const clear = jest.spyOn(global, 'clearInterval')
    handle = (_req, res) => {
      res.writeHead(200)
      res.write('{')
      controller.abort()
    }
    await expect(
      adapter.execute(AUTH, 'name', { kind: 'exec', input: { command: 'true' } }, controller.signal),
    ).rejects.toThrow('may have started')
    expect(clear).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(1)
  })

  it('stops heartbeat promptly when cancelled during auto-resume and never dispatches', async () => {
    box.autoStop = 0.02
    const controller = new AbortController()
    const clear = jest.spyOn(global, 'clearInterval')
    resume.ensureReady.mockImplementation(() => {
      controller.abort()
      return new Promise(() => undefined)
    })
    await expect(
      adapter.execute(AUTH, 'name', { kind: 'exec', input: { command: 'true' } }, controller.signal),
    ).rejects.toThrow('cancelled')
    expect(clear).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(0)
  })

  it('bounds a stalled response and cleans its heartbeat and timeout', async () => {
    box.autoStop = 1
    const originalTimeout = global.setTimeout
    jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(((callback, delay, ...args) =>
        originalTimeout(callback, delay === 30_000 ? 25 : delay, ...args)) as typeof setTimeout)
    const clearHeartbeat = jest.spyOn(global, 'clearInterval')
    const clearDeadline = jest.spyOn(global, 'clearTimeout')
    handle = (_req, res) => {
      res.writeHead(200)
      res.write('{')
    }
    await expect(adapter.execute(AUTH, 'name', { kind: 'metrics' })).rejects.toThrow('unavailable or interrupted')
    await expect(adapter.execute(AUTH, 'name', { kind: 'status', executionId: 'exec-1' })).rejects.toThrow(
      'unavailable or interrupted',
    )
    expect(clearHeartbeat).toHaveBeenCalledTimes(1)
    expect(clearDeadline).toHaveBeenCalled()
  })

  it('cleans heartbeat when readiness fails, without leaking dependency details', async () => {
    box.autoStop = 1
    const clear = jest.spyOn(global, 'clearInterval')
    resume.ensureReady.mockRejectedValue(new Error('runner-secret mcp-secret'))
    await expect(adapter.execute(AUTH, 'name', { kind: 'status', executionId: 'exec-1' })).rejects.toThrow(
      'Runner status unavailable or interrupted',
    )
    expect(clear).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(0)
  })
})
