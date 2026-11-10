/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { testCapacity } from '@boxlite-ai/ci-listener/testing'
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { DataSource } from 'typeorm'
import { Listener } from '@boxlite-ai/ci-listener'
import { CiNativeState } from './ci-native-state'
import { CiNativeHost } from './ci-native-host'
import { CiGitHubService } from './ci-github.service'
import { CiWebhookService } from './ci-webhook.service'
import { CiWebhookController } from './ci-webhook.controller'
import { CI_WEBHOOK_PATH, installCiWebhookBodyParser } from './ci-webhook-body'
import { AddCiListenerState1793700000000 } from '../migrations/pre-deploy/1793700000000-add-ci-listener-state-migration'

const database = process.env.CI_CONNECT_TEST_DATABASE_URL
const integration = database ? describe : describe.skip
integration('CI webhook native HTTP and PostgreSQL', () => {
  const schema = 'ci_native_hook_' + randomUUID().replaceAll('-', ''),
    org = randomUUID(),
    binding = randomUUID(),
    secret = Buffer.from(randomBytes(32).toString('hex'))
  let db: DataSource, store: CiNativeState, app: INestApplication, base: string
  let settings: Record<string, string>
  const config = { get: (name: string) => settings[name] }
  const payload = () => ({
    action: 'queued',
    installation: { id: 10 },
    repository: { id: 30, owner: { id: 20 } },
    workflow_job: { id: 50, run_id: 40, status: 'queued', labels: ['boxlite-ci-runner'], name: '验证 Unicode' },
  })
  const sign = (body: Buffer) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
  const makeService = (state: CiNativeState) => {
    const host = new CiNativeHost(db, state, {} as any, new CiGitHubService(config as any), config as any)
    const listener = new Listener({
      state: state.state,
      host,
      worker: { image: 'runner:test', cpus: 1, memoryMiB: 512, labels: ['boxlite-ci-runner'] },
      capacity: { resolve: async () => testCapacity({ account: 1, tenant: 1 }) },
    })
    return new CiWebhookService(
      { receive: (event: any, application: string) => listener.receive({ ...event, application }) } as any,
      config as any,
    )
  }
  const body = () => Buffer.from(JSON.stringify(payload(), null, 2))
  const send = (raw = body(), headers: Record<string, string> = {}) =>
    fetch(base + CI_WEBHOOK_PATH, {
      method: 'POST',
      body: raw,
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': sign(raw),
        'X-GitHub-Delivery': randomUUID(),
        'X-GitHub-Event': 'workflow_job',
        ...headers,
      },
    })
  async function counts() {
    const rows = await db.query(`SELECT split_part(record_key,'/',1) kind,count(*)::int n FROM ci_listener_state
      WHERE record_key LIKE 'receipt/%' OR record_key LIKE 'notice/%' OR record_key LIKE 'wake/%' GROUP BY kind`)
    return Object.fromEntries(
      ['receipt', 'notice', 'wake'].map((kind) => [kind, rows.find((r) => r.kind === kind)?.n || 0]),
    )
  }
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(database!).hostname))
      throw Error('Disposable local PostgreSQL required')
    db = await new DataSource({
      type: 'postgres',
      url: database,
      extra: { options: `-c search_path=${schema},public` },
    }).initialize()
    await db.query(`CREATE SCHEMA "${schema}";
      CREATE TABLE ci_installation_binding(id uuid PRIMARY KEY,generation bigint,github_host text,
      app_client_id text,installation_id bigint,account_id bigint,account_login text,account_type text,
      organization_id uuid,actor_id text,allow_private boolean,follow_installation boolean,state text);
      CREATE TABLE "user"(id text PRIMARY KEY,role text);
      CREATE TABLE organization_user("organizationId" uuid,"userId" text,role text)`)
    const query = db.createQueryRunner()
    try {
      await new AddCiListenerState1793700000000().up(query)
    } finally {
      await query.release()
    }
    settings = { 'ci.githubClientId': 'test-app', 'ci.githubWebhookSecret': secret.toString('utf8') }
    store = new CiNativeState(db, config as any)
    await store.initialize()
    const module = await Test.createTestingModule({
      controllers: [CiWebhookController],
      providers: [{ provide: CiWebhookService, useValue: makeService(store) }],
    }).compile()
    app = module.createNestApplication({ logger: false })
    installCiWebhookBodyParser(app)
    app.setGlobalPrefix('api')
    await app.listen(0, '127.0.0.1')
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await app?.close()
    if (db?.isInitialized)
      try {
        await db.query(`DROP SCHEMA "${schema}" CASCADE`)
      } finally {
        await db.destroy()
      }
  })
  beforeEach(async () => {
    await db.query('TRUNCATE ci_listener_state,ci_installation_binding,"user",organization_user')
    await db.query(
      `INSERT INTO ci_installation_binding VALUES($1,1,'github.com','test-app',10,20,'owner','User',$2,'owner',true,true,'ready')`,
      [binding, org],
    )
    await db.query(`INSERT INTO "user" VALUES('owner','user')`)
    await db.query(`INSERT INTO organization_user VALUES($1,'owner','owner')`, [org])
    settings = { 'ci.githubClientId': 'test-app', 'ci.githubWebhookSecret': secret.toString('utf8') }
    await store.initialize()
  })
  it('verifies original whitespace and Unicode and commits all inbox facts before HTTP 204', async () => {
    const raw = body(),
      delivery = randomUUID()
    expect((await send(raw, { 'X-GitHub-Delivery': delivery })).status).toBe(204)
    expect(await counts()).toEqual({ receipt: 1, notice: 1, wake: 1 })
    const [receipt] = await store.state.read(['receipt/' + delivery])
    expect(receipt.payload).toMatchObject({ digest: createHash('sha256').update(raw).digest('hex') })
    expect((await store.state.read(['notice/10/50']))[0].payload).toMatchObject({
      repositoryId: 30,
      job: { id: 50, runId: 40 },
    })
  })
  it('deduplicates concurrent redelivery and accepts distinct deliveries for the same job', async () => {
    const raw = body(),
      delivery = randomUUID()
    const results = await Promise.all([
      send(raw, { 'X-GitHub-Delivery': delivery }),
      send(raw, { 'X-GitHub-Delivery': delivery }),
    ])
    expect(results.map((r) => r.status)).toEqual([204, 204])
    expect((await send(raw)).status).toBe(204)
    expect(await counts()).toEqual({ receipt: 2, notice: 1, wake: 1 })
  })
  it('rejects conflicting body and job identities without partial receipts', async () => {
    const raw = body(),
      delivery = randomUUID()
    expect((await send(raw, { 'X-GitHub-Delivery': delivery })).status).toBe(204)
    expect((await send(Buffer.concat([raw, Buffer.from('\n')]), { 'X-GitHub-Delivery': delivery })).status).toBe(409)
    const event = payload()
    event.workflow_job.run_id++
    expect((await send(Buffer.from(JSON.stringify(event)))).status).toBe(409)
    expect(await counts()).toEqual({ receipt: 1, notice: 1, wake: 1 })
  })
  it.each(['', 'bad', 'sha256=' + '0'.repeat(64)])('rejects a missing, malformed or forged HMAC', async (signature) => {
    expect((await send(body(), { 'X-Hub-Signature-256': signature })).status).toBe(401)
    expect(await counts()).toEqual({ receipt: 0, notice: 0, wake: 0 })
  })
  it('rejects byte tampering despite valid JSON', async () => {
    const raw = body()
    expect((await send(Buffer.concat([raw, Buffer.from('\n')]), { 'X-Hub-Signature-256': sign(raw) })).status).toBe(401)
    expect(await counts()).toEqual({ receipt: 0, notice: 0, wake: 0 })
  })
  it('validates signed event structure and delivery UUIDs', async () => {
    expect((await send(body(), { 'X-GitHub-Delivery': 'not-a-uuid' })).status).toBe(400)
    expect((await send(Buffer.from('{invalid'))).status).toBe(400)
    expect((await send(Buffer.from(JSON.stringify({ action: 'queued' })))).status).toBe(400)
    expect(await counts()).toEqual({ receipt: 0, notice: 0, wake: 0 })
  })
  it('ignores unsupported runner labels without creating receipts', async () => {
    const event = payload()
    event.workflow_job.labels = ['ubuntu-latest']
    expect((await send(Buffer.from(JSON.stringify(event)))).status).toBe(204)
    expect(await counts()).toEqual({ receipt: 0, notice: 0, wake: 0 })
  })
  it.each([
    "UPDATE ci_installation_binding SET state='disabled'",
    'DELETE FROM ci_installation_binding',
    'DELETE FROM organization_user',
    'DELETE FROM "user"',
    'UPDATE ci_installation_binding SET account_id=21',
  ])('defers a notification when live binding authority is unavailable', async (sql) => {
    await db.query(sql)
    expect((await send()).status).toBe(503)
    expect(await counts()).toEqual({ receipt: 0, notice: 0, wake: 0 })
  })
  it('stores installation-removal hints without granting execution to a disabled binding', async () => {
    await db.query("UPDATE ci_installation_binding SET state='disabled'")
    const event = { action: 'deleted', installation: { id: 10, account: { id: 20 } } }
    expect((await send(Buffer.from(JSON.stringify(event)), { 'X-GitHub-Event': 'installation' })).status).toBe(204)
    expect(await counts()).toEqual({ receipt: 1, notice: 0, wake: 1 })
    expect((await db.query('SELECT state FROM ci_installation_binding'))[0].state).toBe('disabled')
  })
  it.each(['', 'x'.repeat(31), 'x'.repeat(257), ' '.repeat(64), 'x'.repeat(65537)])(
    'rejects an unusable injected HMAC secret without persistence',
    async (value) => {
      settings['ci.githubWebhookSecret'] = value
      expect((await send()).status).toBe(503)
      expect(await counts()).toEqual({ receipt: 0, notice: 0, wake: 0 })
    },
  )
  it('normalizes surrounding whitespace before verifying HMAC', async () => {
    settings['ci.githubWebhookSecret'] = '\n ' + secret.toString('utf8') + ' \n'
    expect((await send()).status).toBe(204)
    expect(await counts()).toEqual({ receipt: 1, notice: 1, wake: 1 })
  })
  it('measures the injected secret as UTF-8 bytes', async () => {
    const value = 'é'.repeat(16),
      raw = body()
    settings['ci.githubWebhookSecret'] = value
    const signature = 'sha256=' + createHmac('sha256', Buffer.from(value)).update(raw).digest('hex')
    expect((await send(raw, { 'X-Hub-Signature-256': signature })).status).toBe(204)
    expect(await counts()).toEqual({ receipt: 1, notice: 1, wake: 1 })
  })
  it('rejects media type, compression and oversized bodies before acceptance', async () => {
    expect((await send(body(), { 'Content-Type': 'text/plain' })).status).toBe(415)
    expect((await send(gzipSync(body()), { 'Content-Encoding': 'gzip' })).status).toBe(415)
    expect((await send(Buffer.alloc(1048577, 32))).status).toBe(413)
    expect(await counts()).toEqual({ receipt: 0, notice: 0, wake: 0 })
  })
  it('accepts an exactly 1 MiB signed JSON body', async () => {
    const event = { ...payload(), padding: '' }
    event.padding = 'x'.repeat(1048576 - Buffer.byteLength(JSON.stringify(event)))
    const raw = Buffer.from(JSON.stringify(event))
    expect(raw.length).toBe(1048576)
    expect((await send(raw)).status).toBe(204)
    expect(await counts()).toEqual({ receipt: 1, notice: 1, wake: 1 })
  })
  it('rolls back all receipt and notice writes when the final wake write fails', async () => {
    await db.query(`CREATE FUNCTION reject_wake() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.record_key LIKE 'wake/%' THEN RAISE EXCEPTION 'test wake failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_wake BEFORE INSERT OR UPDATE ON ci_listener_state FOR EACH ROW EXECUTE FUNCTION reject_wake()`)
    const raw = body(),
      delivery = randomUUID()
    try {
      expect((await send(raw, { 'X-GitHub-Delivery': delivery })).status).toBe(503)
    } finally {
      await db.query('DROP TRIGGER reject_wake ON ci_listener_state; DROP FUNCTION reject_wake()')
    }
    expect(await counts()).toEqual({ receipt: 0, notice: 0, wake: 0 })
    expect((await send(raw, { 'X-GitHub-Delivery': delivery })).status).toBe(204)
  })
  it('defers on binding lock timeout and accepts the same delivery after release', async () => {
    const lock = db.createQueryRunner()
    await lock.connect()
    await lock.startTransaction()
    await lock.query('SELECT * FROM ci_installation_binding FOR UPDATE')
    const raw = body(),
      delivery = randomUUID()
    try {
      expect((await send(raw, { 'X-GitHub-Delivery': delivery })).status).toBe(503)
    } finally {
      await lock.rollbackTransaction()
      await lock.release()
    }
    expect(await counts()).toEqual({ receipt: 0, notice: 0, wake: 0 })
    expect((await send(raw, { 'X-GitHub-Delivery': delivery })).status).toBe(204)
  }, 10000)
  it('preserves deduplication through host and service recreation', async () => {
    const raw = body(),
      delivery = randomUUID()
    expect((await send(raw, { 'X-GitHub-Delivery': delivery })).status).toBe(204)
    const replacement = new CiNativeState(db, config as any)
    await replacement.initialize()
    await makeService(replacement).receive(raw, sign(raw), delivery, 'workflow_job')
    expect(await counts()).toEqual({ receipt: 1, notice: 1, wake: 1 })
  })
  it('does not reinitialize an inbox with a missing persistent owner', async () => {
    expect((await send()).status).toBe(204)
    await db.query("DELETE FROM ci_listener_state WHERE record_key='@owner'")
    expect((await send()).status).toBe(503)
    expect(await counts()).toEqual({ receipt: 1, notice: 1, wake: 1 })
  })
})
