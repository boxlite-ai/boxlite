import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { writeFileSync } from 'node:fs'
import { RunnerAdapterV0 } from './runnerAdapter.v0'
import { Runner } from '../entities/runner.entity'
import { Box } from '../entities/box.entity'

describe('Runner V0 internal nesting wire contract', () => {
  it('reads live capability, forwards saved true and preserves ordinary create/recover requests', async () => {
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
      const box = Object.assign(new Box('local', 'test'), {
        id: 'wire-box',
        authToken: 'synthetic-token',
        errorReason: 'recover',
      })
      for (const nestedVirtualization of [undefined, false, true]) {
        Object.assign(box, { nestedVirtualization })
        await adapter.createBox(box, 'alpine:latest')
        await adapter.recoverBox(box)
      }
      const writes = requests.filter((request) => request.method === 'POST')
      expect(writes[0]).toEqual(writes[2])
      expect(writes[1]).toEqual(writes[3])
      for (const request of writes.slice(0, 4)) expect(request.body).not.toHaveProperty('nestedVirtualization')
      for (const request of writes.slice(4)) expect(request.body).toHaveProperty('nestedVirtualization', true)
      if (process.env.NESTED_ORG_WIRE_CAPTURE)
        writeFileSync(process.env.NESTED_ORG_WIRE_CAPTURE, JSON.stringify(writes.slice(0, 4), null, 2))
      for (const nestedVirtualization of [false, true]) {
        Object.assign(box, { nestedVirtualization, privileged: true })
        await adapter.createBox(box, 'alpine:latest')
        await adapter.recoverBox(box)
      }
      const privilegedWrites = requests.slice(-4)
      for (const request of privilegedWrites) expect(request.body).toHaveProperty('privileged', true)
      for (const request of privilegedWrites.slice(0, 2))
        expect(request.body).not.toHaveProperty('nestedVirtualization')
      for (const request of privilegedWrites.slice(2)) expect(request.body).toHaveProperty('nestedVirtualization', true)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
