import { NotFoundException } from '@nestjs/common'
import { Hono } from 'hono'
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { PassThrough } from 'node:stream'
import type { ApiKey } from '../../../api-key/api-key.entity'
import type { ApiKeyService } from '../../../api-key/api-key.service'
import { generateApiKeyValue } from '../../../common/utils/api-key'
import { OrganizationResourcePermission as Permission } from '../../../organization/enums/organization-resource-permission.enum'
import type { OrganizationUserService } from '../../../organization/services/organization-user.service'
import { CloudAppCredentials } from '../../cloud-app-credentials'
import type { Ctx } from '../ctx'
import type { AppRow, EnvRow } from '../db'
import { serveAppOrigin } from './app-origin'
import { handleUpgrade } from './upgrade'

type Key = Pick<ApiKey, 'organizationId' | 'userId' | 'permissions' | 'expiresAt'>

function gateway() {
  const keys = new Map<string, Key>()
  const credentials = new CloudAppCredentials(
    {
      getApiKeyByValue: async (token: string) => {
        const key = keys.get(token)
        if (!key) throw new NotFoundException()
        return key
      },
    } as ApiKeyService,
    {
      findOne: async (_organization: string, userId: string) => (userId === 'member' ? { userId } : null),
    } as OrganizationUserService,
  )
  const apps = ['docs', 'wiki'].map((name) => ({ id: `app_${name}`, name, org_id: 'org-a' }) as AppRow)
  const envs = apps.map(
    (app) =>
      ({
        id: `env_${app.name}`,
        app_id: app.id,
        name: 'main',
        box_id: `box_${app.name}`,
        box_url: 'https://box.example.test',
        live_deployment: 1,
        forward_secret: 'test-forwarding-secret',
      }) as EnvRow,
  )
  const ctx = {
    credentials,
    store: {
      appById: async (id: string) => apps.find((app) => app.id === id),
      envById: async (id: string) => envs.find((env) => env.id === id),
    },
    resources: {
      currentSpec: async () => ({ public_paths: ['/healthz'] }),
      effectiveAccess: async () => 'private',
      boxStatus: async () => 'running',
      appUrl: async (name: string) => `https://${name}.apps.example.test`,
    },
  } as unknown as Ctx

  return {
    ctx,
    key(overrides: Partial<Key> = {}) {
      const token = generateApiKeyValue('blk', 'test')
      keys.set(token, { organizationId: 'org-a', userId: 'member', permissions: [Permission.READ_APPS], ...overrides })
      return token
    },
    request(app: string, token: string, path = '/') {
      const server = new Hono()
      const env = envs.find((row) => row.id === `env_${app}`)!
      server.get('*', (c) => serveAppOrigin(ctx, c, env))
      return server.request(`https://${app}.apps.example.test${path}`, {
        headers: { authorization: `Bearer ${token}` },
      })
    },
  }
}

describe('Organization API keys at the App gateway', () => {
  afterEach(() => jest.restoreAllMocks())

  it('opens multiple private Apps in the organization without forwarding the key', async () => {
    const app = gateway()
    const key = app.key()
    const upstream = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok'))
    expect((await app.request('docs', key)).status).toBe(200)
    expect((await app.request('wiki', key)).status).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(2)
    for (const [, request] of upstream.mock.calls)
      expect((request!.headers as Headers).has('authorization')).toBe(false)
  })

  it.each([
    { reason: 'another organization', organizationId: 'org-b' },
    { reason: 'missing read:apps', permissions: [Permission.WRITE_APPS] },
    { reason: 'expired', expiresAt: new Date(0) },
    { reason: 'former member', userId: 'former-member' },
  ])('refuses a recognized key on a public path when it is $reason', async ({ reason: _reason, ...claims }) => {
    const app = gateway()
    const upstream = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    expect((await app.request('docs', app.key(claims), '/healthz')).status).toBe(401)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('preserves an application bearer token on a public path', async () => {
    const app = gateway()
    const upstream = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    expect((await app.request('docs', 'app-session-token', '/healthz')).status).toBe(200)
    expect((upstream.mock.calls[0][1]!.headers as Headers).get('authorization')).toBe('Bearer app-session-token')
  })

  it('consumes the organization key before a WebSocket upgrade reaches the Box', async () => {
    const app = gateway()
    const request = { url: '/', method: 'GET', headers: { authorization: `Bearer ${app.key()}` } } as IncomingMessage
    const socket = new PassThrough()
    const upstream = jest
      .spyOn(jest.requireActual('node:https'), 'request')
      .mockReturnValue(Object.assign(new EventEmitter(), { end: jest.fn() }))
    try {
      await handleUpgrade(app.ctx, request, socket, Buffer.alloc(0), 'env_docs')
      expect(upstream).toHaveBeenCalledTimes(1)
      expect(upstream.mock.calls[0][1]).toMatchObject({
        headers: expect.not.objectContaining({ authorization: expect.anything() }),
      })
    } finally {
      socket.destroy()
    }
  })
})
