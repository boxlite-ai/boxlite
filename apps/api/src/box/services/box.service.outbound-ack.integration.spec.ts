import { randomUUID } from 'node:crypto'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { DataSource } from 'typeorm'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxRepository } from '../repositories/box.repository'
import { BoxService } from './box.service'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip

type ServiceFixture = { database: DataSource; schema: string; box: Box; service: BoxService }
type Snapshot = { revision: string; policy: { mode: 'enabled' | 'disabled'; allow_net: string[] } }

/** Own real PostgreSQL/HTTP resources while keeping the public Service invocation identical on the baseline. */
async function withOutboundService(
  respond: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  check: (fixture: ServiceFixture) => Promise<void>,
): Promise<void> {
  if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST)) throw new Error('Requires loopback PostgreSQL')
  const schema = `outbound_ack_${process.pid}_${randomUUID().replaceAll('-', '')}`
  const database = await new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    schema,
    entities: [Box, BoxLastActivity],
    synchronize: false,
    entitySkipConstructor: true,
    extra: { options: `-c search_path=${schema},public` },
  }).initialize()
  let ownsSchema = false
  const failures: unknown[] = []
  const handlers: Promise<void>[] = []
  const http = createServer((request, response) => {
    handlers.push(
      Promise.resolve()
        .then(() => respond(request, response))
        .catch((error) => {
          failures.push(error)
          response.destroy()
        }),
    )
  })
  try {
    await database.query(`CREATE SCHEMA "${schema}"`)
    ownsSchema = true
    await database.synchronize()
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const runner = {
      id: randomUUID(),
      apiUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
      apiKey: 'synthetic-key',
    }
    const box = Object.assign(new Box('local', 'outbound-regression'), {
      organizationId: randomUUID(),
      runnerId: runner.id,
      osUser: 'boxlite',
      labels: {},
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STARTED,
      pending: false,
    })
    await database.getRepository(Box).insert(box)
    const repository = new BoxRepository(
      database,
      { emit: jest.fn() } as never,
      { invalidate: jest.fn(), invalidateOrgId: jest.fn() } as never,
    )
    const service = Object.create(BoxService.prototype) as BoxService
    Object.assign(service, { boxRepository: repository, runnerService: { findOne: async () => runner } })
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(box)
    await check({ database, schema, box, service })
    await Promise.all(handlers)
    if (failures.length) throw failures[0]
  } finally {
    http.closeAllConnections()
    if (http.listening) await new Promise<void>((resolve) => http.close(() => resolve()))
    if (ownsSchema) await database.query(`DROP SCHEMA "${schema}" CASCADE`)
    await database.destroy()
    jest.restoreAllMocks()
  }
}

describeIfDatabase('BoxService outbound regressions (real PostgreSQL and HTTP)', () => {
  it('rejects status-only success and preserves the stored policy', async () => {
    let requests = 0
    await withOutboundService(
      (_request, response) => {
        requests++
        response.end('{}')
      },
      async ({ database, box, service }) => {
        await expect(
          service.setOutboundNetwork(box.id, { mode: 'disabled', allow_net: [] }, box.organizationId),
        ).rejects.toThrow()
        expect(requests).toBeGreaterThan(0)
        const stored = await database.getRepository(Box).findOneByOrFail({ id: box.id })
        expect(stored.outboundEnabled).toBe(true)
      },
    )
  }, 20000)

  it('preserves a newer Runtime policy when publication fails and compensation becomes stale', async () => {
    const newer: Snapshot = {
      revision: 'external-newer',
      policy: { mode: 'enabled', allow_net: ['198.51.100.0/24'] },
    }
    let live: Snapshot = { revision: 'initial', policy: { mode: 'enabled', allow_net: [] } }
    let applied = 0
    await withOutboundService(
      async (request, response) => {
        expect(request.headers.authorization).toBe('Bearer synthetic-key')
        response.setHeader('Content-Type', 'application/json')
        if (request.method === 'GET' && request.url?.endsWith('/network/outbound/status')) {
          response.end(
            JSON.stringify({
              persisted: live,
              runtime_persisted: live,
              observed: { ...live, application_state: 'confirmed' },
              application_state: 'confirmed',
              capabilities: ['revision-v1'],
            }),
          )
          return
        }
        if (
          request.method !== 'PUT' ||
          (!request.url?.endsWith('/network/outbound') && !request.url?.endsWith('/network/outbound/snapshot'))
        ) {
          throw new Error(`Unexpected control request: ${request.method} ${request.url}`)
        }
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const policy = JSON.parse(Buffer.concat(chunks).toString()) as Snapshot['policy']
        if (request.url.endsWith('/snapshot') && request.headers['if-match'] !== `"${live.revision}"`) {
          response.writeHead(412).end()
          return
        }
        applied++
        const revision = request.headers['x-boxlite-outbound-revision']
        live = { revision: typeof revision === 'string' ? revision : `legacy-${applied}`, policy }
        response.setHeader('ETag', `"${live.revision}"`)
        response.end(JSON.stringify(policy))
        // Another control owner wins after this ACK, before Cloud attempts its failing SQL publication.
        if (applied === 1) live = structuredClone(newer)
      },
      async ({ database, schema, box, service }) => {
        await database.query(`CREATE SEQUENCE "${schema}".outbound_publication_failures`)
        await database.query(`CREATE FUNCTION "${schema}".reject_disabled_outbound() RETURNS trigger AS $$
          BEGIN
            IF NEW."outboundEnabled" = false THEN
              PERFORM nextval('"${schema}".outbound_publication_failures'::regclass);
              RAISE EXCEPTION 'synthetic publication failure';
            END IF;
            RETURN NEW;
          END; $$ LANGUAGE plpgsql`)
        await database.query(`CREATE TRIGGER reject_disabled_outbound BEFORE UPDATE ON "${schema}".box
          FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_disabled_outbound()`)
        await expect(
          service.setOutboundNetwork(box.id, { mode: 'disabled', allow_net: [] }, box.organizationId),
        ).rejects.toThrow()
        // Sequence advancement survives rollback and proves that the real SQL failure boundary was reached.
        expect(
          (await database.query(`SELECT is_called FROM "${schema}".outbound_publication_failures`))[0].is_called,
        ).toBe(true)
        expect(live).toEqual(newer)
        expect(applied).toBe(1)
        expect((await database.getRepository(Box).findOneByOrFail({ id: box.id })).outboundEnabled).toBe(true)
      },
    )
  }, 20000)
})
