// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)

test('retries a rate-limited Runner registration', async () => {
  let registrationAttempts = 0
  const registrationRequests: Array<{ authorization: string | undefined; body: unknown }> = []
  const server = createServer((request, response) => {
    if (request.url === '/api/health') {
      response.writeHead(200).end()
      return
    }
    if (request.url === '/api/admin/runners' && request.method === 'POST') {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => {
        body += chunk
      })
      request.on('end', () => {
        registrationRequests.push({ authorization: request.headers.authorization, body: JSON.parse(body) })
        registrationAttempts += 1
        response.writeHead(registrationAttempts === 1 ? 429 : 201).end()
      })
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })

  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const result = await execFileAsync(process.execPath, ['scripts/register-runners.mjs'], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        API_URL: `http://127.0.0.1:${address.port}`,
        ADMIN_API_KEY: 'test-admin-key',
        REGION_ID: 'test-region',
        RUNNERS: JSON.stringify([{ name: 'runner-2', apiKey: 'test-runner-key' }]),
      },
      timeout: 10_000,
    })
    assert.match(result.stdout, /runner-2 registered/)
    assert.equal(registrationAttempts, 2)
    assert.deepEqual(registrationRequests, [
      {
        authorization: 'Bearer test-admin-key',
        body: { name: 'runner-2', apiKey: 'test-runner-key', apiVersion: '2', regionId: 'test-region' },
      },
      {
        authorization: 'Bearer test-admin-key',
        body: { name: 'runner-2', apiKey: 'test-runner-key', apiVersion: '2', regionId: 'test-region' },
      },
    ])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})
