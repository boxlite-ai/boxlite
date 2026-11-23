import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { RunnerAdapterV0 } from './runnerAdapter.v0'
import { Runner } from '../entities/runner.entity'
import { Box } from '../entities/box.entity'

describe('Runner V0 internal nesting wire contract', () => {
  it('reads live capability, forwards this attempt and preserves ordinary create requests', async () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = []
    let capability: unknown = true
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      requests.push({
        method: request.method,
        path: request.url,
        body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null,
      })
      response.setHeader('Content-Type', 'application/json')
      response.end(
        JSON.stringify(
          request.url === '/info' ? { nestedVirtualizationEnabled: capability, supportsPrivileged: true } : {},
        ),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const adapter = new RunnerAdapterV0()
      const runner = new Runner({
        region: 'local',
        name: 'test',
        apiKey: 'synthetic-key',
        apiVersion: '0',
        apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        cpu: 1,
        memoryGiB: 1,
        diskGiB: 1,
      })
      runner.supportsPrivileged = true
      await adapter.init(runner)
      expect(await adapter.runnerInfo()).toMatchObject({ nestedVirtualizationEnabled: true, supportsPrivileged: true })
      capability = false
      expect(await adapter.runnerInfo()).toMatchObject({ nestedVirtualizationEnabled: false, supportsPrivileged: true })
      capability = true
      const box = Object.assign(new Box('local', 'test'), {
        id: 'wire-box',
        authToken: 'synthetic-token',
        errorReason: 'recover',
      })
      for (const nestedVirtualization of [undefined, false, true]) {
        await adapter.createBox(box, 'alpine:latest', undefined, nestedVirtualization)
      }
      const writes = requests.filter((request) => request.method === 'POST')
      expect(writes[0]).toEqual(writes[1])
      for (const request of writes.slice(0, 2)) expect(request.body).not.toHaveProperty('nestedVirtualization')
      expect(writes[2].body).toHaveProperty('nestedVirtualization', true)
      for (const enabled of [false, true]) {
        box.privileged = true
        await adapter.createBox(box, 'alpine:latest', undefined, enabled)
      }
      const privileged = requests.filter((request) => request.method === 'POST').slice(-2)
      for (const request of privileged) expect(request.body).toHaveProperty('privileged', true)
      expect(privileged[0].body).not.toHaveProperty('nestedVirtualization')
      expect(privileged[1].body).toHaveProperty('nestedVirtualization', true)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
