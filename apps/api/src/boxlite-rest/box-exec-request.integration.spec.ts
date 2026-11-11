jest.mock('http-proxy-middleware', () => ({ createProxyMiddleware: jest.fn(), fixRequestBody: jest.fn() }))

import { createServer, Server } from 'node:http'
import { createServer as createHttpsServer, globalAgent } from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { BoxRequestService } from './box-request.service'
import { BoxliteProxyController } from './boxlite-proxy.controller'
import { AddBoxRequests1794390000000 } from '../migrations/pre-deploy/1794390000000-add-box-requests-migration'
import { EventEmitter } from 'node:events'

const describeDatabase = process.env.DB_HOST ? describe : describe.skip
const schema = `exec_request_${randomUUID().replaceAll('-', '')}`

describeDatabase('keyed execution proxy with PostgreSQL and HTTP boundary', () => {
  let database: DataSource
  let server: Server
  let base: string
  let generation: string
  let starts: number
  let token: string
  let requests: BoxRequestService
  const organizationId = randomUUID()

  beforeAll(async () => {
    database = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema,
      extra: { options: `-c search_path=${schema},public` },
    }).initialize()
    await database.query(`CREATE SCHEMA "${schema}"`)
    const runner = database.createQueryRunner()
    try {
      await new AddBoxRequests1794390000000().up(runner)
    } finally {
      await runner.release()
    }
    requests = new BoxRequestService(database)
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url.endsWith('exec-generation')) {
        res.end(JSON.stringify({ generation }))
      } else {
        starts++
        token = String(req.headers['idempotency-key'])
        expect(req.headers['x-boxlite-exec-generation']).toBe(generation)
        res.statusCode = 201
        res.end(JSON.stringify({ execution_id: 'guest-id' }))
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    await requests?.onModuleDestroy()
    if (database?.isInitialized) {
      try {
        await database.query(`DROP SCHEMA "${schema}" CASCADE`)
      } finally {
        await database.destroy()
      }
    }
  })

  beforeEach(async () => {
    await database.query('TRUNCATE box_request')
    generation = 'vm:1'
    starts = 0
  })

  async function call(key: string, command = 'echo') {
    const boxes = {
      findOneByIdOrName: async () => ({ id: 'box', runnerId: 'runner', autoResume: false }),
      updateLastActivityAt: async () => {},
    }
    const controller = new BoxliteProxyController(
      boxes as never,
      { findOne: async () => ({ apiUrl: base, apiKey: 'fixture-token' }) } as never,
      {} as never,
      {} as never,
      requests,
    )
    const res = Object.assign(new EventEmitter(), { status: jest.fn().mockReturnThis(), json: jest.fn() })
    await controller.proxyExec(
      { organizationId, userId: 'owner' } as never,
      'box',
      {
        method: 'POST',
        headers: { 'idempotency-key': key },
        body: { command },
      } as never,
      res as never,
      jest.fn(),
    )
    return res
  }

  it('requires a trusted runner certificate for keyed HTTPS calls', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'runner-tls-'))
    const key = join(directory, 'key.pem')
    const cert = join(directory, 'cert.pem')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    )
    const secure = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) })
    secure.on('request', (...args) => server.emit('request', ...args))
    const original = base
    const originalCa = globalAgent.options.ca
    try {
      await new Promise<void>((resolve) => secure.listen(0, '127.0.0.1', resolve))
      base = `https://127.0.0.1:${(secure.address() as AddressInfo).port}`
      delete globalAgent.options.ca
      await expect(call(randomUUID())).rejects.toThrow('self-signed certificate')
      expect(starts).toBe(0)
      globalAgent.options.ca = readFileSync(cert)
      const result = await call(randomUUID())
      expect(result.json).toHaveBeenCalledWith({ execution_id: 'guest-id' })
      expect(starts).toBe(1)
    } finally {
      base = original
      if (originalCa === undefined) delete globalAgent.options.ca
      else globalAgent.options.ca = originalCa
      await new Promise<void>((resolve) => secure.close(() => resolve()))
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not follow runner redirects or send execution to their target', async () => {
    const original = base
    const redirect = createServer((_req, res) => {
      res.writeHead(302, { location: `${original}/v1/boxes/box/exec-generation` })
      res.end()
    })
    try {
      await new Promise<void>((resolve) => redirect.listen(0, '127.0.0.1', resolve))
      base = `http://127.0.0.1:${(redirect.address() as AddressInfo).port}`
      await expect(call(randomUUID())).rejects.toMatchObject({ status: 302 })
      expect(starts).toBe(0)
    } finally {
      base = original
      await new Promise<void>((resolve) => redirect.close(() => resolve()))
    }
  })

  it('replays the recorded execution without another runner start and rejects payload changes', async () => {
    const key = randomUUID()
    const first = await call(key)
    expect(first.json).toHaveBeenCalledWith({ execution_id: 'guest-id' })
    expect(token).toMatch(/^[a-f0-9-]{36}\.\d+$/)
    await call(key)
    expect(starts).toBe(1)
    await expect(call(key, 'different')).rejects.toMatchObject({ status: 422 })
    expect(starts).toBe(1)
  })

  it('does not extend the deadline on replay and accepts expired keys as new requests', async () => {
    const key = randomUUID()
    await call(key)
    const firstToken = token
    const [first] = await database.query('SELECT "expiresAt" FROM box_request')
    await call(key)
    const [replayed] = await database.query('SELECT "expiresAt" FROM box_request')
    expect(replayed.expiresAt).toEqual(first.expiresAt)
    await database.query('UPDATE box_request SET "expiresAt" = now() - interval \'1 second\'')
    await call(key, 'new command')
    expect(starts).toBe(2)
    expect(token).not.toBe(firstToken)
  })

  it('recovers an unsaved response on the same VM and refuses a replaced VM', async () => {
    const key = randomUUID()
    await call(key)
    const originalToken = token
    await database.query('UPDATE box_request SET response = NULL')
    await call(key)
    expect(token).toBe(originalToken)
    expect(starts).toBe(2) // HTTP retried; guest deduplication is tested in Rust.
    await database.query('UPDATE box_request SET response = NULL')
    generation = 'vm:2'
    await expect(call(key)).rejects.toMatchObject({ status: 409 })
    expect(starts).toBe(2)
  })
})
