/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ForbiddenException } from '@nestjs/common'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { BoxliteProxyController } from './boxlite-proxy.controller'

jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: jest.fn(),
  fixRequestBody: jest.fn(),
}))
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid'),
  validate: jest.fn(() => true),
}))

const activeAuth = {
  organizationId: 'org-1',
  organization: { id: 'org-1', suspended: false } as any,
}

function makeBoxService(overrides: Partial<Record<string, any>> = {}) {
  return {
    findOneByIdOrName: jest.fn().mockResolvedValue({ id: 'box-uuid', runnerId: 'runner-1' }),
    updateLastActivityAt: jest.fn().mockResolvedValue(undefined),
    ensureStartedForProxy: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeRunnerService() {
  return {
    findOne: jest.fn().mockResolvedValue({ apiUrl: 'http://runner.local', apiKey: 'runner-key' }),
  }
}

describe('BoxliteProxyController', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('rewrites public box ids to internal box ids before proxying exec requests to the runner', async () => {
    const proxyHandler = jest.fn()
    jest.mocked(createProxyMiddleware).mockReturnValue(proxyHandler as never)

    const boxService = makeBoxService()
    const runnerService = makeRunnerService()
    const controller = new BoxliteProxyController(boxService as never, runnerService as never)
    const req = { url: '/api/v1/boxes/public-box/exec' }
    const res = {}
    const next = jest.fn()

    await controller.proxyExec(activeAuth as never, 'public-box', req as never, res as never, next)

    const proxyOptions = jest.mocked(createProxyMiddleware).mock.calls[0][0]
    const pathRewrite = proxyOptions.pathRewrite as (path: string, req: unknown) => string
    expect(pathRewrite('/api/v1/boxes/public-box/exec', req)).toBe('/v1/boxes/box-uuid/exec')
    expect(boxService.findOneByIdOrName).toHaveBeenCalledWith('public-box', 'org-1')
    expect(proxyHandler).toHaveBeenCalledWith(req, res, next)
  })

  it('asks the control plane to start the box before proxying exec, so an auto-started box is not stopped back', async () => {
    jest.mocked(createProxyMiddleware).mockReturnValue(jest.fn() as never)

    const boxService = makeBoxService()
    const runnerService = makeRunnerService()
    const controller = new BoxliteProxyController(boxService as never, runnerService as never)
    const req = { url: '/api/v1/boxes/public-box/exec' }

    await controller.proxyExec(activeAuth as never, 'public-box', req as never, {} as never, jest.fn())

    expect(boxService.ensureStartedForProxy).toHaveBeenCalledWith('public-box', activeAuth.organization)
  })

  it('also fires the start hint for files and metrics proxy paths', async () => {
    jest.mocked(createProxyMiddleware).mockReturnValue(jest.fn() as never)

    const boxService = makeBoxService()
    const runnerService = makeRunnerService()
    const controller = new BoxliteProxyController(boxService as never, runnerService as never)
    const req = { url: '/api/v1/boxes/public-box/files?path=/tmp' }

    await controller.proxyFiles(activeAuth as never, 'public-box', req as never, {} as never, jest.fn())
    expect(boxService.ensureStartedForProxy).toHaveBeenCalledWith('public-box', activeAuth.organization)

    boxService.ensureStartedForProxy.mockClear()
    const metricsReq = { url: '/api/v1/boxes/public-box/metrics' }
    await controller.proxyMetrics(activeAuth as never, 'public-box', metricsReq as never, {} as never, jest.fn())
    expect(boxService.ensureStartedForProxy).toHaveBeenCalledWith('public-box', activeAuth.organization)
  })

  it('still proxies the exec when the control-plane start hint fails (best-effort)', async () => {
    const proxyHandler = jest.fn()
    jest.mocked(createProxyMiddleware).mockReturnValue(proxyHandler as never)

    const boxService = makeBoxService({
      ensureStartedForProxy: jest.fn().mockRejectedValue(new Error('db down')),
    })
    const runnerService = makeRunnerService()
    const controller = new BoxliteProxyController(boxService as never, runnerService as never)
    const req = { url: '/api/v1/boxes/public-box/exec' }
    const res = {}
    const next = jest.fn()

    await controller.proxyExec(activeAuth as never, 'public-box', req as never, res as never, next)

    expect(proxyHandler).toHaveBeenCalledWith(req, res, next)
  })

  // ❶ regression guard: if the hint ever regresses to a blocking write that
  // never resolves, the 2s race fallback must still let the proxy proceed.
  // Without this test, future refactors could silently drop the setTimeout
  // tier of Promise.race and the proxy would hang forever.
  it('still proxies the exec when the start hint hangs past the 2s timeout', async () => {
    jest.useFakeTimers()
    const proxyHandler = jest.fn()
    jest.mocked(createProxyMiddleware).mockReturnValue(proxyHandler as never)

    const boxService = makeBoxService({
      // Never resolves — simulates the contended-row-lock scenario.
      ensureStartedForProxy: jest.fn().mockReturnValue(new Promise<void>(() => {})),
    })
    const runnerService = makeRunnerService()
    const controller = new BoxliteProxyController(boxService as never, runnerService as never)
    const req = { url: '/api/v1/boxes/public-box/exec' }
    const res = {}
    const next = jest.fn()

    const pending = controller.proxyExec(activeAuth as never, 'public-box', req as never, res as never, next)

    // Advance past the 2s hint timeout so the setTimeout tier of the race wins.
    await jest.advanceTimersByTimeAsync(2500)
    await pending

    expect(proxyHandler).toHaveBeenCalledWith(req, res, next)
    jest.useRealTimers()
  })

  // ❷ suspension is a hard wall: ForbiddenException must surface as 403 to
  // the caller and the proxy must NOT run. Without re-throw, a suspended org
  // could exec / files / metrics a STOPPED box back to STARTED, bypassing
  // the start() gate entirely.
  it('refuses to proxy when the start hint reports a suspended organization', async () => {
    const proxyHandler = jest.fn()
    jest.mocked(createProxyMiddleware).mockReturnValue(proxyHandler as never)

    const boxService = makeBoxService({
      ensureStartedForProxy: jest.fn().mockRejectedValue(new ForbiddenException('Organization is suspended')),
    })
    const runnerService = makeRunnerService()
    const controller = new BoxliteProxyController(boxService as never, runnerService as never)
    const req = { url: '/api/v1/boxes/public-box/exec' }

    await expect(
      controller.proxyExec(activeAuth as never, 'public-box', req as never, {} as never, jest.fn()),
    ).rejects.toThrow(ForbiddenException)

    expect(proxyHandler).not.toHaveBeenCalled()
  })
})
