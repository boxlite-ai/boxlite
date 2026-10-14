import { MetricsInterceptor } from './metrics.interceptor'

// The inbound metric is keyed on the route path inside a per-method switch, so
// a case filed under the wrong method is silently never reached. Pin the
// method each inbound route actually uses.
function makeInterceptor() {
  const posthog = { capture: jest.fn() }
  const interceptor = Object.create(MetricsInterceptor.prototype) as MetricsInterceptor
  Object.assign(interceptor as any, {
    posthog,
    configService: { get: jest.fn().mockReturnValue('test') },
    logger: { error: jest.fn() },
  })
  return { interceptor, posthog }
}

function request(method: string, path: string, params: Record<string, string>, body?: unknown) {
  return {
    method,
    route: { path },
    params,
    body,
    user: { userId: 'user-1', organizationId: 'org-1' },
    get: () => undefined,
  }
}

describe('MetricsInterceptor inbound mode', () => {
  it.each([
    ['/api/v1/boxes/:boxId/network/inbound', 'enabled'],
    ['/api/v1/:prefix/boxes/:boxId/network/inbound', 'disabled'],
  ])('captures PUT %s with mode %s', async (path, mode) => {
    const { interceptor, posthog } = makeInterceptor()

    await (interceptor as any).recordMetrics(request('PUT', path, { boxId: 'box-1' }, { mode }), { statusCode: 200 }, 0)

    expect(posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'api_box_inbound_mode_updated',
        properties: expect.objectContaining({ box_id: 'box-1', box_inbound_mode: mode }),
      }),
    )
  })
})
