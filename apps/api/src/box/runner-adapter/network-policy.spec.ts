import { setRunnerOutbound } from './network-policy'
import { Runner } from '../entities/runner.entity'

describe('outbound policy runner control', () => {
  afterEach(() => jest.restoreAllMocks())

  const runner = { apiUrl: 'http://runner.test/', apiKey: 'test-key' } as Runner

  it('sends an authenticated replacement and waits for acknowledgement', async () => {
    const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    await setRunnerOutbound(runner, 'box/1', { mode: 'enabled', allow_net: [] })
    expect(fetcher).toHaveBeenCalledWith(
      'http://runner.test/v1/boxes/box%2F1/network/outbound',
      expect.objectContaining({
        method: 'PUT',
        headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
        body: '{"mode":"enabled","allow_net":[]}',
      }),
    )
  })

  it('rejects legacy runners instead of reporting success', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }))
    await expect(setRunnerOutbound(runner, 'box1', { mode: 'enabled', allow_net: [] })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'unsupported' }),
    })
  })

  it('falls back to the proxy endpoint', async () => {
    const fetcher = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    await setRunnerOutbound({ proxyUrl: 'http://proxy.test', apiKey: 'k' } as Runner, 'box1', {
      mode: 'disabled',
      allow_net: [],
    })
    expect(fetcher).toHaveBeenCalledWith('http://proxy.test/v1/boxes/box1/network/outbound', expect.anything())
  })

  it('refuses a runner without a control endpoint', async () => {
    const fetcher = jest.spyOn(global, 'fetch')
    await expect(setRunnerOutbound({} as Runner, 'box1', { mode: 'enabled', allow_net: [] })).rejects.toThrow(
      'no control endpoint',
    )
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('reports an unacknowledged request as retryable', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('timeout'))
    await expect(setRunnerOutbound(runner, 'box1', { mode: 'enabled', allow_net: [] })).rejects.toThrow(
      'not acknowledged',
    )
  })

  it('maps an untyped runner failure to upstream_unavailable', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('bad gateway', { status: 502 }))
    await expect(setRunnerOutbound(runner, 'box1', { mode: 'enabled', allow_net: [] })).rejects.toMatchObject({
      response: { message: 'Runner rejected outbound policy', code: 'upstream_unavailable' },
      status: 502,
    })
  })

  it('preserves a typed runtime refusal', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: 'box stopped', code: 'invalid_state' },
        }),
        { status: 409 },
      ),
    )
    await expect(setRunnerOutbound(runner, 'box1', { mode: 'enabled', allow_net: [] })).rejects.toMatchObject({
      response: { message: 'box stopped', code: 'invalid_state' },
    })
  })
})
