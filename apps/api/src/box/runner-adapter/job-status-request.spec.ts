import { createServer, IncomingMessage } from 'node:http'
import { AddressInfo } from 'node:net'
import { JobsApi } from '../../../../libs/api-client/src/api/jobs-api'
import { Configuration } from '../../../../libs/api-client/src/configuration'

describe('job status SDK request compatibility', () => {
  it.each([undefined, 'current-claim'])('preserves the wire request with claim token %s', async (claimToken) => {
    let received: { method: string; url: string; headers: IncomingMessage['headers']; body: unknown }
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      received = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      }
      response.setHeader('Content-Type', 'application/json')
      response.end('{}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const api = new JobsApi(
        new Configuration({
          basePath: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          accessToken: 'test-token',
          baseOptions: { proxy: false },
        }),
      )
      await api.updateJobStatus('job-1', {
        status: 'IN_PROGRESS',
        ...(claimToken === undefined ? {} : { claimToken }),
      })
      expect(received.method).toBe('POST')
      expect(received.url).toBe('/jobs/job-1/status')
      expect(received.headers['content-type']).toBe('application/json')
      expect(received.headers.authorization).toBe('Bearer test-token')
      expect(received.body).toEqual(
        claimToken === undefined ? { status: 'IN_PROGRESS' } : { status: 'IN_PROGRESS', claimToken: 'current-claim' },
      )
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })
})
