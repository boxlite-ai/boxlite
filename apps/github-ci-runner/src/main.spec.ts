/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ListenerState } from '@boxlite-ai/ci-listener'
import { SqliteStateDatabase } from '../../libs/ci-listener/src/state/sqlite'
import * as configuration from './config'

it('initializes the standalone entrypoint with a leased App registry and durable SQLite state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-main-')),
    originalFetch = global.fetch,
    originalExit = process.exitCode,
    originalSignals = new Set(process.listeners('SIGTERM'))
  const key = join(directory, 'app.pem')
  writeFileSync(
    key,
    generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  )
  const reservation = createServer()
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve))
  const port = (reservation.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())))
  const config = configuration.loadConfig({
    BOXLITE_REST_URL: 'https://box.test',
    BOXLITE_API_KEY: 'private-fixture-key',
    CI_GITHUB_APP_CLIENT_ID: 'test-client',
    CI_GITHUB_APP_PRIVATE_KEY_FILE: key,
    CI_STATE_DIR: join(directory, 'state'),
    CI_LISTEN_ADDR: '127.0.0.1:' + port,
  })
  const configured = jest.spyOn(configuration, 'loadConfig').mockReturnValue(config)
  let report!: (event: object) => void, closed!: () => void
  const outcome = new Promise<object>((resolve) => {
    report = resolve
  })
  const shutdown = new Promise<void>((resolve) => {
    closed = resolve
  })
  const close = SqliteStateDatabase.prototype.close
  const closing = jest.spyOn(SqliteStateDatabase.prototype, 'close').mockImplementation(async function (
    this: SqliteStateDatabase,
  ) {
    await close.call(this)
    closed()
  })
  const capture = (message: unknown) => {
    if (typeof message !== 'string') return
    try {
      const value = JSON.parse(message)
      if (['ci-listener-started', 'ci-listener-failed'].includes(value.event)) report(value)
    } catch {}
  }
  const logging = jest.spyOn(console, 'log').mockImplementation(capture)
  const errors = jest.spyOn(console, 'error').mockImplementation(capture)
  global.fetch = jest.fn(async (input) => {
    const url = new URL(String(input))
    if (url.origin === 'https://box.test' && url.pathname === '/v1/me')
      return new Response(JSON.stringify({ sub: 'owner', principal_type: 'service_account', path_prefix: 'tenant' }))
    if (url.origin === 'https://api.github.com' && url.pathname === '/app/installations') return new Response('[]')
    throw Error('Unexpected startup fixture request')
  }) as typeof fetch
  let success = false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    require('./main')
    const event = await Promise.race([
      outcome,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('Startup did not settle')), 3000)
      }),
    ])
    expect(event).toEqual({ event: 'ci-listener-started', auth: 'app', webhook: false })
    let ready = false
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const health = await originalFetch(`http://127.0.0.1:${port}/healthz`)
      if ((await health.json()).discovery === 'ready') {
        ready = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(ready).toBe(true)
    success = true
  } finally {
    if (timer) clearTimeout(timer)
    for (const signal of process.listeners('SIGTERM')) if (!originalSignals.has(signal)) signal('SIGTERM')
    await shutdown
    configured.mockRestore()
    closing.mockRestore()
    logging.mockRestore()
    errors.mockRestore()
    global.fetch = originalFetch
    process.exitCode = originalExit
    if (!success) rmSync(directory, { recursive: true, force: true })
  }
  const database = new SqliteStateDatabase(config.stateDir)
  try {
    const [root] = await new ListenerState(database, 'ci-listener').read(['backend/github'])
    expect(root.payload).toMatchObject({ kind: 'app', issuer: 'test-client', applications: ['test-client'] })
  } finally {
    await database.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
