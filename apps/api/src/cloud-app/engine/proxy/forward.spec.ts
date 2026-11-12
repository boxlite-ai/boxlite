import { generateApiKeyValue } from '../../../common/utils/api-key'
import type { Ctx } from '../ctx'
import type { AppRow, EnvRow } from '../db'
import { forward, isPlatformHeader } from './forward'

describe('App proxy credentials', () => {
  afterEach(() => jest.restoreAllMocks())

  test('drops the platform proxy credential before forwarding visitor traffic', async () => {
    const serviceKey = generateApiKeyValue('blk', 'svc')
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    const ctx = {
      resources: { boxStatus: async () => 'running', appUrl: async () => 'https://app.example.test' },
      tunnelHeaders: async () => ({ 'x-boxlite-access-token': 'private-tunnel-token' }),
    } as unknown as Ctx
    const app = { name: 'example' } as AppRow
    const env = {
      name: 'main',
      active_box_id: 'box1',
      box_url: 'https://box.example.test',
      live_deployment: 1,
      forward_secret: 'gateway-token',
    } as EnvRow
    await forward(ctx, app, env, {
      method: 'GET',
      path: '/',
      body: null,
      headers: new Headers({
        'x-boxlite-proxy-token': serviceKey,
        'x-boxlite-access-token': 'spoofed',
        'x-request-id': 'request1',
      }),
    })
    const headers = fetchMock.mock.calls[0][1]!.headers as Headers
    expect(headers.has('x-boxlite-proxy-token')).toBe(false)
    expect(headers.get('x-boxlite-access-token')).toBe('private-tunnel-token')
    expect(headers.get('x-boxlite-gateway')).toBe('gateway-token')
    expect(headers.get('x-request-id')).toBe('request1')
    expect(isPlatformHeader('x-boxlite-proxy-token')).toBe(true)
  })
})
