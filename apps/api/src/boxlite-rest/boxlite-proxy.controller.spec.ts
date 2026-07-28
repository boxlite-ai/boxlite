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
jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-uuid'), validate: jest.fn(() => true) }))

const activeAuth = {
  organizationId: 'org-1',
  organization: { id: 'org-1', suspended: false } as any,
}

function makeHarness() {
  const boxService = {
    findOneByIdOrName: jest.fn().mockResolvedValue({ id: 'box-uuid', runnerId: 'runner-1', autoResume: true }),
    updateLastActivityAt: jest.fn().mockResolvedValue(undefined),
    getNetworkTunnelUrl: jest.fn().mockResolvedValue('https://3000-box.proxy.test'),
  }
  const runnerService = {
    findOne: jest.fn().mockResolvedValue({ apiUrl: 'http://runner.local', apiKey: 'runner-key' }),
  }
  const autoResume = { ensureReady: jest.fn().mockResolvedValue(undefined) }
  const controller = new BoxliteProxyController(boxService as never, runnerService as never, autoResume as never)
  return { controller, boxService, autoResume }
}

describe('BoxliteProxyController', () => {
  beforeEach(() => jest.clearAllMocks())

  it('rewrites public box ids to internal box ids before proxying exec', async () => {
    const proxyHandler = jest.fn()
    jest.mocked(createProxyMiddleware).mockReturnValue(proxyHandler as never)
    const { controller, boxService } = makeHarness()
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

  it('returns the public endpoint for JSON tunnel requests', async () => {
    const { controller, boxService } = makeHarness()

    const result = await controller.proxyNetworkTunnel(activeAuth as never, 'public-box', 3000)

    expect(boxService.getNetworkTunnelUrl).toHaveBeenCalledWith('public-box', 'org-1', 3000)
    expect(result).toEqual({ uri: 'https://3000-box.proxy.test' })
  })

  it('auto-resumes exec and files but treats metrics as observation-only', async () => {
    jest.mocked(createProxyMiddleware).mockReturnValue(jest.fn() as never)
    const { controller, boxService, autoResume } = makeHarness()

    await controller.proxyExec(activeAuth as never, 'public-box', { url: '/exec' } as never, {} as never, jest.fn())
    await controller.proxyFiles(activeAuth as never, 'public-box', { url: '/files' } as never, {} as never, jest.fn())
    expect(autoResume.ensureReady).toHaveBeenCalledTimes(2)
    expect(boxService.updateLastActivityAt).toHaveBeenCalledTimes(2)

    autoResume.ensureReady.mockClear()
    boxService.updateLastActivityAt.mockClear()
    await controller.proxyMetrics(
      activeAuth as never,
      'public-box',
      { url: '/metrics' } as never,
      {} as never,
      jest.fn(),
    )
    expect(autoResume.ensureReady).not.toHaveBeenCalled()
    expect(boxService.updateLastActivityAt).not.toHaveBeenCalled()
  })

  it('does not proxy when the strict AutoResume gate fails', async () => {
    const proxyHandler = jest.fn()
    jest.mocked(createProxyMiddleware).mockReturnValue(proxyHandler as never)
    const { controller, autoResume } = makeHarness()
    autoResume.ensureReady.mockRejectedValue(new Error('start failed'))

    await expect(
      controller.proxyExec(activeAuth as never, 'public-box', { url: '/exec' } as never, {} as never, jest.fn()),
    ).rejects.toThrow('start failed')
    expect(proxyHandler).not.toHaveBeenCalled()
  })

  it('does not auto-resume a box whose autoResume switch is off', async () => {
    jest.mocked(createProxyMiddleware).mockReturnValue(jest.fn() as never)
    const { controller, boxService, autoResume } = makeHarness()
    boxService.findOneByIdOrName.mockResolvedValue({ id: 'box-uuid', runnerId: 'runner-1', autoResume: false })

    await controller.proxyExec(activeAuth as never, 'public-box', { url: '/exec' } as never, {} as never, jest.fn())

    expect(autoResume.ensureReady).not.toHaveBeenCalled()
  })

  it('surfaces suspended-organization failures and never proxies', async () => {
    const proxyHandler = jest.fn()
    jest.mocked(createProxyMiddleware).mockReturnValue(proxyHandler as never)
    const { controller, autoResume } = makeHarness()
    autoResume.ensureReady.mockRejectedValue(new ForbiddenException('Organization is suspended'))

    await expect(
      controller.proxyExec(activeAuth as never, 'public-box', { url: '/exec' } as never, {} as never, jest.fn()),
    ).rejects.toThrow(ForbiddenException)
    expect(proxyHandler).not.toHaveBeenCalled()
  })
})
