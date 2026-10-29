/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ThrottlerStorageService } from '@nestjs/throttler'
import { McpRateLimitGuard } from './mcp-rate-limit.guard'

describe('MCP shared organization throttles', () => {
  let storage: ThrottlerStorageService
  let guard: McpRateLimitGuard
  const context = (tool: string, organization = 'org') =>
    ({
      getClass: () => McpRateLimitGuard,
      getHandler: () => McpRateLimitGuard.prototype.canActivate,
      switchToHttp: () => ({
        getRequest: () => ({
          user: { userId: 'user', role: 'user', organization: { id: organization } },
          body: { method: 'tools/call', params: { name: tool } },
        }),
        getResponse: () => ({ header: jest.fn() }),
      }),
    }) as unknown as ExecutionContext
  beforeEach(async () => {
    storage = new ThrottlerStorageService()
    guard = new McpRateLimitGuard(
      [
        { name: 'box-create', ttl: 60000, limit: 1 },
        { name: 'box-lifecycle', ttl: 60000, limit: 1 },
      ],
      storage,
      new Reflector(),
      { get: async () => null } as never,
    )
    await guard.onModuleInit()
  })
  afterEach(() => storage.onApplicationShutdown())
  it('shares stop/delete capacity, applies the create bucket, and leaves polling available', async () => {
    await expect(guard.canActivate(context('stop_box'))).resolves.toBe(true)
    await expect(guard.canActivate(context('delete_box'))).rejects.toMatchObject({ status: 429 })
    await expect(guard.canActivate(context('create_box'))).resolves.toBe(true)
    await expect(guard.canActivate(context('create_box'))).rejects.toMatchObject({ status: 429 })
    await expect(guard.canActivate(context('get_execution'))).resolves.toBe(true)
    await expect(guard.canActivate(context('create_box', 'other-org'))).resolves.toBe(true)
  })
})
