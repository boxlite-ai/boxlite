/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

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

describe('BoxliteProxyController', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('rewrites public box ids to internal box ids before proxying exec requests to the runner', async () => {
    const proxyHandler = jest.fn()
    jest.mocked(createProxyMiddleware).mockReturnValue(proxyHandler as never)

    const boxService = {
      findOneByIdOrName: jest.fn().mockResolvedValue({
        id: 'box-uuid',
        runnerId: 'runner-1',
      }),
      updateLastActivityAt: jest.fn().mockResolvedValue(undefined),
    }
    const runnerService = {
      findOne: jest.fn().mockResolvedValue({
        apiUrl: 'http://runner.local',
        apiKey: 'runner-key',
      }),
    }

    const controller = new BoxliteProxyController(boxService as never, runnerService as never)
    const req = { url: '/api/v1/boxes/public-box/exec' }
    const res = {}
    const next = jest.fn()

    await controller.proxyExec({ organizationId: 'org-1' } as never, 'public-box', req as never, res as never, next)

    const proxyOptions = jest.mocked(createProxyMiddleware).mock.calls[0][0]
    const pathRewrite = proxyOptions.pathRewrite as (path: string, req: unknown) => string
    expect(pathRewrite('/api/v1/boxes/public-box/exec', req)).toBe('/v1/boxes/box-uuid/exec')
    expect(boxService.findOneByIdOrName).toHaveBeenCalledWith('public-box', 'org-1')
    expect(proxyHandler).toHaveBeenCalledWith(req, res, next)
  })
})
