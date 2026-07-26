/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { PATH_METADATA } from '@nestjs/common/constants'
import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import type { AddressInfo } from 'net'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { BoxService } from '../box/services/box.service'
import { BoxStateWaiterService } from '../box/services/box-state-waiter.service'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxliteProxyController } from './boxlite-proxy.controller'
import { BoxliteWsProxyService } from './boxlite-ws-proxy.service'

jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: jest.fn(),
  fixRequestBody: jest.fn(),
}))
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid'),
  validate: jest.fn(() => true),
}))

describe('BoxLite REST routing', () => {
  let app: INestApplication
  const createBox = jest.fn().mockResolvedValue({
    id: 'box-created',
    name: 'created-box',
    state: BoxState.STARTED,
    createdAt: new Date('2026-07-25T00:00:00.000Z'),
    updatedAt: new Date('2026-07-25T00:00:01.000Z'),
    image: 'ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3',
    cpu: 1,
    memory: 1,
    labels: {},
    pid: 4321,
  })

  async function startRoutingTestApp() {
    const moduleRef = await Test.createTestingModule({
      controllers: [BoxliteBoxController],
      providers: [
        {
          provide: BoxService,
          useValue: {
            create: createBox,
            findAllDeprecated: jest.fn().mockResolvedValue([]),
            toBoxDtos: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: BoxStateWaiterService,
          useValue: {},
        },
      ],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          context.switchToHttp().getRequest().user = {
            organizationId: 'org-123',
            organization: { id: 'org-123' },
          }
          return true
        },
      })
      .overrideGuard(OrganizationResourceActionGuard)
      .useValue({ canActivate: () => true })
      .compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    await app.listen(0)
  }

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const address = app.getHttpServer().address() as AddressInfo
    return fetch(`http://127.0.0.1:${address.port}${path}`, init)
  }

  async function get(path: string): Promise<Response> {
    return request(path)
  }

  async function post(path: string, body: Record<string, unknown>): Promise<Response> {
    return request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  afterEach(async () => {
    await app?.close()
    createBox.mockClear()
  })

  it('mounts box controllers at canonical and legacy default-prefix routes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, BoxliteBoxController)).toEqual(['v1/boxes', 'v1/:prefix/boxes'])
    expect(Reflect.getMetadata(PATH_METADATA, BoxliteProxyController)).toEqual(['v1/boxes', 'v1/:prefix/boxes'])
  })

  it('registers canonical and legacy default-prefix routes in the Nest HTTP router', async () => {
    await startRoutingTestApp()

    const canonical = await get('/api/v1/boxes')
    const legacy = await get('/api/v1/default/boxes')

    expect(canonical.status).toBe(200)
    expect(await canonical.json()).toEqual({ boxes: [] })
    expect(legacy.status).toBe(200)
    expect(await legacy.json()).toEqual({ boxes: [] })
  })

  it.each([
    ['rootfs_path', '/srv/runner/rootfs'],
    ['working_dir', '/workspace'],
    ['entrypoint', ['/bin/sh']],
    ['cmd', ['-lc', 'id']],
    ['volumes', [{ host_path: '/etc', guest_path: '/host' }]],
    ['ports', [{ host_port: 22, guest_port: 22, host_ip: '127.0.0.1' }]],
    ['secrets', [{ name: 'token', value: 'not-a-real-secret' }]],
    ['security', 'development'],
    ['advanced', { new_pid_ns: false }],
    ['runtime', { home_dir: '/srv/boxlite' }],
    ['auto_remove', true],
    ['health_check', { command: ['true'] }],
    ['tty', true],
  ])('rejects unsupported create field %s at the Apps HTTP boundary', async (field, value) => {
    await startRoutingTestApp()

    const response = await post('/api/v1/boxes', { image: 'base', [field]: value })

    expect(response.status).toBe(400)
    expect(createBox).not.toHaveBeenCalled()
  })

  it('rejects unknown nested network fields at the Apps HTTP boundary', async () => {
    await startRoutingTestApp()

    const response = await post('/api/v1/boxes', {
      image: 'base',
      network: { mode: 'enabled', allow_net: ['api.openai.com'], host_ip: '127.0.0.1' },
    })

    expect(response.status).toBe(400)
    expect(createBox).not.toHaveBeenCalled()
  })

  it('applies the strict create allowlist to the legacy prefixed route', async () => {
    await startRoutingTestApp()

    const response = await post('/api/v1/default/boxes', {
      image: 'base',
      rootfs_path: '/srv/runner/rootfs',
    })

    expect(response.status).toBe(400)
    expect(createBox).not.toHaveBeenCalled()
  })

  it('rejects invalid values in otherwise allowlisted fields before creation', async () => {
    await startRoutingTestApp()

    const response = await post('/api/v1/boxes', {
      image: 'base',
      env: { RETRIES: 3 },
    })

    expect(response.status).toBe(400)
    expect(createBox).not.toHaveBeenCalled()
  })

  it('accepts the implemented create allowlist and tolerates legacy detach without mapping it', async () => {
    await startRoutingTestApp()

    const response = await post('/api/v1/boxes', {
      name: 'worker',
      image: 'base',
      cpus: 1,
      memory_mib: 256,
      disk_size_gb: 1,
      env: { MODE: 'worker' },
      user: 'boxlite',
      network: { mode: 'enabled', allow_net: ['api.openai.com'] },
      auto_pause: 900,
      auto_delete: 3600,
      auto_resume: false,
      detach: true,
    })

    expect(response.status).toBe(201)
    expect(createBox).toHaveBeenCalledTimes(1)
    const [mapped] = createBox.mock.calls[0]
    expect(mapped).toMatchObject({
      name: 'worker',
      image: 'base',
      cpu: 1,
      memory: 1,
      disk: 1,
      env: { MODE: 'worker' },
      user: 'boxlite',
      networkBlockAll: false,
      networkAllowList: 'api.openai.com',
      autoPause: 900,
      autoDelete: 3600,
      autoResume: false,
    })
    expect(mapped).not.toHaveProperty('detach')
    const body = (await response.json()) as Record<string, unknown>
    expect(body).not.toHaveProperty('pid')
  })

  it('matches websocket attach upgrades with or without a routing prefix', () => {
    const service = new BoxliteWsProxyService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    )

    expect(service.matchAttachPath('/api/v1/boxes/box-1/executions/exec-1/attach')).toEqual({ boxId: 'box-1' })
    expect(service.matchAttachPath('/api/v1/default/boxes/box-1/executions/exec-1/attach')).toEqual({
      boxId: 'box-1',
      tenant: 'default',
    })
  })

  it('does not route HTTP duplex tunnels through the websocket proxy', () => {
    const service = new BoxliteWsProxyService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    )

    expect(service.matchAttachPath('/api/v1/boxes/box-1/network/tunnel?port=3000')).toBeNull()
  })
})
