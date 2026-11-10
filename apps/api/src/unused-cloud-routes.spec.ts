/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ExecutionContext, INestApplication, Type } from '@nestjs/common'
import { GUARDS_METADATA, MODULE_METADATA } from '@nestjs/common/constants'
import { Test } from '@nestjs/testing'
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger'
import { EventEmitter } from 'node:events'
import { AddressInfo } from 'node:net'
import { AppModule } from './app.module'

// Proxy transport is outside this router fixture and ships as ESM.
jest.mock('http-proxy-middleware', () => ({ createProxyMiddleware: jest.fn(), fixRequestBody: jest.fn() }))

const retiredRoutes = [
  ['POST', '/users/user-1/regenerate-key-pair', '/users/{id}/regenerate-key-pair'],
  ['GET', '/box/box-1/telemetry/logs', '/box/{boxId}/telemetry/logs'],
  ['GET', '/box/box-1/telemetry/traces', '/box/{boxId}/telemetry/traces'],
  ['GET', '/box/box-1/telemetry/traces/trace-1', '/box/{boxId}/telemetry/traces/{traceId}'],
  ['GET', '/box/box-1/telemetry/metrics', '/box/{boxId}/telemetry/metrics'],
  ['GET', '/object-storage/push-access', '/object-storage/push-access'],
  ['GET', '/box', '/box'],
  ['PUT', '/box/box-1/labels', '/box/{boxIdOrName}/labels'],
  ['GET', '/volumes/by-name/data', '/volumes/by-name/{name}'],
  ['POST', '/box/box-1/autostop/15', '/box/{boxIdOrName}/autostop/{interval}'],
  ['POST', '/box/box-1/autodelete/15', '/box/{boxIdOrName}/autodelete/{interval}'],
] as const

// Discover controllers through the production module registrations so removing
// an import actually removes its routes from this fixture as well.
function productControllers(): Type[] {
  const modules: Type[] = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule)
  const selected = new Set([
    'BoxController',
    'VolumeController',
    'UserController',
    'ObjectStorageController',
    'BoxTelemetryController',
  ])
  return modules
    .flatMap((module) => Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, module) ?? [])
    .filter((controller: Type) => selected.has(controller.name))
}

describe('retired cloud operations', () => {
  let app: INestApplication
  let base: string
  let document: OpenAPIObject
  const box = { id: 'box-1', labels: {} }
  const boxes = {
    findAllDeprecated: jest.fn().mockResolvedValue([box]),
    findAll: jest.fn().mockResolvedValue({ items: [box], total: 1, page: 1, totalPages: 1 }),
    toBoxDtos: jest.fn(async (items) => items),
    toBoxDto: jest.fn(async (item) => item),
    findOneByIdOrName: jest.fn().mockResolvedValue(box),
    replaceLabels: jest.fn().mockResolvedValue(box),
    setAutostopInterval: jest.fn().mockResolvedValue(box),
    setAutoDeleteInterval: jest.fn().mockResolvedValue(box),
  }

  beforeAll(async () => {
    const subscriber = Object.assign(new EventEmitter(), { subscribe: jest.fn().mockResolvedValue(1) })
    const controllers = productControllers()
    const builder = Test.createTestingModule({ controllers }).useMocker((token) => {
      if (typeof token === 'string') return { duplicate: () => subscriber }
      switch (typeof token === 'function' ? token.name : '') {
        case 'BoxService':
          return boxes
        case 'UserService':
          return { regenerateKeyPair: async () => ({ id: 'user-1' }) }
        case 'VolumeService':
          return { findByName: async () => ({ id: 'volume-1', name: 'data' }) }
        case 'ObjectStorageService':
          return { getPushAccess: async () => ({ organizationId: 'org-1' }) }
        case 'BoxTelemetryService':
          return {
            getLogs: async () => ({ items: [] }),
            getTraces: async () => ({ items: [] }),
            getTraceSpans: async () => [],
            getMetrics: async () => ({ series: [] }),
          }
        default:
          return {}
      }
    })
    for (const controller of controllers) {
      const handlers = Object.getOwnPropertyNames(controller.prototype)
        .map((name) => Object.getOwnPropertyDescriptor(controller.prototype, name)?.value)
        .filter((handler) => typeof handler === 'function')
      for (const target of [controller, ...handlers]) {
        for (const guard of Reflect.getMetadata(GUARDS_METADATA, target) ?? []) {
          builder.overrideGuard(guard).useValue({
            canActivate: (context: ExecutionContext) => {
              context.switchToHttp().getRequest().user = { organizationId: 'org-1', organization: { id: 'org-1' } }
              return true
            },
          })
        }
      }
    }
    const module = await builder.compile()
    app = module.createNestApplication()
    document = SwaggerModule.createDocument(app, new DocumentBuilder().build())
    app.setGlobalPrefix('api')
    await app.listen(0, '127.0.0.1')
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api`
  })

  afterAll(async () => {
    await app?.close()
  })

  it.each(retiredRoutes)('%s %s is absent from the router and OpenAPI', async (method, path, schemaPath) => {
    const response = await fetch(base + path, {
      method,
      ...(method === 'PUT' ? { headers: { 'content-type': 'application/json' }, body: '{"labels":{}}' } : {}),
    })
    expect(response.status).toBe(404)
    expect(document.paths[schemaPath]?.[method.toLowerCase()]).toBeUndefined()
  })

  it('retains the paginated box list', async () => {
    const response = await fetch(`${base}/box/paginated`)
    expect(response.status).toBe(200)
    expect(boxes.findAll).toHaveBeenCalled()
    expect(document.paths['/box/paginated'].get).toBeDefined()
  })
})
