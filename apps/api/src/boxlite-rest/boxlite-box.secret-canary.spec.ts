/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import 'reflect-metadata'
import { randomUUID } from 'crypto'
import { CallHandler, ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { firstValueFrom, of } from 'rxjs'
import { AuditInterceptor } from '../audit/interceptors/audit.interceptor'
import { BoxDto } from '../box/dto/box.dto'
import { Box } from '../box/entities/box.entity'
import { BoxliteBoxController } from './boxlite-box.controller'
import { boxToBoxResponse } from './mappers/box-to-box.mapper'

// A secret value the API holds must never leave it through what a create
// produces: the audit record, the response, or a JSON dump of the entity
// (POL-1024). Each channel is checked against a fresh canary, after showing
// that the same serialization would reveal a planted copy.
describe('secret canary on box create', () => {
  const canary = `canary-not-a-real-key-${randomUUID()}`
  const secrets = [{ name: 'openai', value: canary, hosts: ['api.openai.com'] }]

  function storedBox(): Box {
    const box = new Box('us', 'canary')
    box.secrets = secrets
    return box
  }

  it('keeps the value out of the response and the entity JSON', () => {
    const box = storedBox()
    expect(JSON.stringify(box.secrets)).toContain(canary)

    const response = boxToBoxResponse(BoxDto.fromBox(box, 'https://proxy.invalid'))

    expect(JSON.stringify(response)).not.toContain(canary)
    expect(JSON.stringify(box)).not.toContain(canary)
  })

  it('keeps the value out of the audit record', async () => {
    const auditService = {
      createLog: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      updateLog: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    }
    const interceptor = new AuditInterceptor(new Reflector(), auditService as any, { get: jest.fn() } as any)
    const body = { image: 'alpine:latest', env: { TOKEN: canary }, secrets }
    expect(JSON.stringify(body)).toContain(canary)
    const request = {
      url: '/api/v1/boxes',
      ip: '127.0.0.1',
      params: {},
      body,
      user: { userId: 'user-1', email: 'dev@example.com', organizationId: 'org-1' },
      get: jest.fn(),
    }
    const context = {
      getHandler: () => BoxliteBoxController.prototype.createBox,
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode: 201 }) }),
    } as unknown as ExecutionContext
    const result = boxToBoxResponse(BoxDto.fromBox(storedBox(), 'https://proxy.invalid'))
    const next: CallHandler = { handle: () => of(result) }

    await firstValueFrom(interceptor.intercept(context, next))

    expect(auditService.createLog).toHaveBeenCalled()
    const recorded = JSON.stringify([auditService.createLog.mock.calls, auditService.updateLog.mock.calls])
    expect(recorded).toContain('openai')
    expect(recorded).not.toContain(canary)
  })
})
