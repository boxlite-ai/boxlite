import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { RunnerAdapterV0 } from './runnerAdapter.v0'

it('keeps legacy start bodies and requires the new protocol before a nested start', async () => {
  const requests: Array<{ method: string; url: URL; body: unknown }> = []
  let startCapability: unknown
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push({
      method: request.method,
      url: new URL(request.url, 'http://test'),
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null,
    })
    response.setHeader('Content-Type', 'application/json')
    response.end(
      JSON.stringify(
        request.url === '/info'
          ? {
              nestedVirtualizationEnabled: true,
              nestedVirtualizationStartEnabled: startCapability,
            }
          : {},
      ),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const adapter = new RunnerAdapterV0({ getOrThrow: () => 1 } as any)
    await adapter.init({
      id: 'runner',
      apiVersion: '0',
      apiKey: 'synthetic',
      apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    } as any)
    const metadata = { key: 'value' }
    await expect((adapter.startBox as any)('box', 'token', metadata, true)).rejects.toThrow(/nested virtualization/i)
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0)

    startCapability = true
    await (adapter.startBox as any)('box', 'token', metadata, true)
    await adapter.startBox('box', 'token', metadata)
    await (adapter as any).boxApiClient.start('box', false, 'token', metadata)
    const posts = requests.filter((r) => r.method === 'POST')
    expect(posts.map((r) => r.url.searchParams.get('nestedVirtualization'))).toEqual(['true', null, 'false'])
    expect(posts.map((r) => r.body)).toEqual([metadata, metadata, metadata])
    expect(posts.every((r) => r.url.searchParams.get('token') === 'token')).toBe(true)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
