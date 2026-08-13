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
  const server = createServer((request, response) => {
    if (request.url === '/api/health') {
      response.writeHead(200).end()
      return
    }
    if (request.url === '/api/admin/runners' && request.method === 'POST') {
      registrationAttempts += 1
      response.writeHead(registrationAttempts === 1 ? 429 : 201).end()
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const result = await execFileAsync(process.execPath, ['scripts/register-runners.mjs'], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        API_URL: `http://127.0.0.1:${address.port}`,
        ADMIN_API_KEY: 'test-admin-key',
        RUNNERS: JSON.stringify([{ name: 'runner-2', apiKey: 'test-runner-key' }]),
      },
      timeout: 10_000,
    })
    assert.match(result.stdout, /runner-2 registered/)
    assert.equal(registrationAttempts, 2)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})
