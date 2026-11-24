import { Logger } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger'
import { createHash, randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { AddSecretCredential1794873600000 } from '../../migrations/pre-deploy/1794873600000-add-secret-credential-migration'
import { SecretCredentialController, SECRET_CREDENTIAL_PATH } from '../controllers/secret-credential.controller'
import { SecretCredentialService } from './secret-credential.service'
import { RunnerAdapterV2 } from '../runner-adapter/runnerAdapter.v2'

const describeDatabase = process.env.DB_HOST ? describe : describe.skip

describeDatabase('Secret credentials with real PostgreSQL and HTTP', () => {
  let db: DataSource
  let service: SecretCredentialService
  let app: any
  const request = (_server: unknown) => ({
    post: (path: string) => ({
      send: async (body: unknown) => {
        const response = await fetch((await app.getUrl()) + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        return {
          status: response.status,
          headers: { 'cache-control': response.headers.get('cache-control') },
          body: await response.json(),
        }
      },
    }),
  })
  const schema = `credential_${randomUUID().replaceAll('-', '')}`
  const binding = {
    runnerId: 'runner-1',
    boxId: 'box-1',
    organizationId: randomUUID(),
    secretIds: [randomUUID(), randomUUID()],
  }

  beforeAll(async () => {
    db = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      extra: { options: `-c search_path=${schema}` },
    }).initialize()
    await db.query(`CREATE SCHEMA "${schema}"`)
    await db.query(
      'CREATE TABLE box (id varchar(64) PRIMARY KEY, "runnerId" text, "organizationId" uuid, "desiredState" text, state text)',
    )
    const runner = db.createQueryRunner()
    try {
      await new AddSecretCredential1794873600000().up(runner)
    } finally {
      await runner.release()
    }
    service = new SecretCredentialService(db)
    const module = await Test.createTestingModule({
      controllers: [SecretCredentialController],
      providers: [{ provide: SecretCredentialService, useValue: service }],
    }).compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api', { exclude: [SECRET_CREDENTIAL_PATH] })
    await app.listen(0, '127.0.0.1')
  })

  beforeEach(async () => {
    await db.query('TRUNCATE box CASCADE')
    await db.query("INSERT INTO box VALUES ($1, $2, $3, 'started', 'starting')", [
      binding.boxId,
      binding.runnerId,
      binding.organizationId,
    ])
  })

  afterAll(async () => {
    await app?.close()
    if (db?.isInitialized) {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`)
      await db.destroy()
    }
  })

  it('issues from v2 refs with only hash stored and consumes exactly once over HTTP', async () => {
    const jobs = {
      createJob: jest.fn().mockResolvedValue({ id: 'job', runnerId: binding.runnerId }),
      notifyRunner: jest.fn(),
    }
    const adapter = new RunnerAdapterV2({} as any, { manager: db.manager } as any, jobs as any)
    Object.assign(adapter, { config: { get: () => true }, credentials: service })
    await adapter.init({ id: binding.runnerId } as any)
    await adapter.createBox(
      {
        id: binding.boxId,
        organizationId: binding.organizationId,
        secrets: binding.secretIds.map((secretId, i) => ({
          secretId,
          name: `secret-${i}`,
          value: 'must-not-leak',
          hosts: ['example.com'],
          headers: { authorization: '{value}' },
        })),
      } as any,
      'base',
    )
    const payload = jobs.createJob.mock.calls[0][5]
    expect(JSON.stringify(payload)).not.toContain('must-not-leak')
    expect(payload.secrets[0]).not.toHaveProperty('value')
    const { token, expiresAt } = payload.secretCredential
    expect(token).toMatch(/^bxsc_[A-Za-z0-9_-]{43}$/)
    const [row] = await db.query('SELECT * FROM secret_credential')
    expect(row.token_hash).toEqual(createHash('sha256').update(token).digest())
    expect(JSON.stringify(row)).not.toContain(token)
    expect(row.expires_at.getTime() - row.issued_at.getTime()).toBe(900_000)
    expect(row.expires_at.toISOString()).toBe(expiresAt)
    const invoke = (runner_id = binding.runnerId) =>
      request(app.getHttpServer())
        .post('/' + SECRET_CREDENTIAL_PATH)
        .send({ token, runner_id })
    expect((await invoke('wrong-runner')).body).toEqual({ active: false })
    const result = await invoke()
    expect(result.status).toBe(200)
    expect(result.headers['cache-control']).toBe('no-store')
    expect(result.body).toEqual({
      active: true,
      credential_id: row.id,
      runner_id: binding.runnerId,
      box_id: binding.boxId,
      organization_id: binding.organizationId,
      grants: binding.secretIds.map((secret_id) => ({ secret_id })),
      expires_at: expiresAt,
    })
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation()
    try {
      expect((await invoke()).body).toEqual({ active: false })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(row.id))
      expect(JSON.stringify(warn.mock.calls)).not.toContain(token)
    } finally {
      warn.mockRestore()
    }
  })

  it('allows only one concurrent consumer across connections', async () => {
    const { token } = await service.issue(binding)
    const responses = await Promise.all(Array.from({ length: 8 }, () => service.consume(token, binding.runnerId)))
    expect(responses.filter((r) => r.active)).toHaveLength(1)
    expect(responses.filter((r) => !r.active)).toEqual(Array(7).fill({ active: false }))
  })

  it('rejects expiry at the boundary and deleted boxes', async () => {
    const expired = await service.issue(binding)
    await db.query("UPDATE secret_credential SET issued_at = now() - interval '15 minutes', expires_at = now()")
    expect(await service.consume(expired.token, binding.runnerId)).toEqual({ active: false })
    const deleted = await service.issue(binding)
    await db.query('DELETE FROM box WHERE id = $1', [binding.boxId])
    expect(await service.consume(deleted.token, binding.runnerId)).toEqual({ active: false })
    expect(await db.query('SELECT * FROM secret_credential')).toEqual([])
  })

  it('keeps malformed and unknown tokens inactive and hides the route from OpenAPI', async () => {
    for (const token of [null, {}, '', 'bxsc_' + 'a'.repeat(43)]) {
      const result = await request(app.getHttpServer())
        .post('/' + SECRET_CREDENTIAL_PATH)
        .send({ token, runner_id: binding.runnerId })
      expect(result.status).toBe(200)
      expect(result.body).toEqual({ active: false })
    }
    expect(
      (
        await request(app.getHttpServer())
          .post('/api/' + SECRET_CREDENTIAL_PATH)
          .send({})
      ).status,
    ).toBe(404)
    expect(SwaggerModule.createDocument(app, new DocumentBuilder().build()).paths).toEqual({})
  })
})
