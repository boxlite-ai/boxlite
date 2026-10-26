import { ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { AddressInfo } from 'net'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { AllExceptionsFilter } from '../../filters/all-exceptions.filter'
import { SystemRole } from '../../user/enums/system-role.enum'
import { AdminUsageService } from '../services/usage.service'
import { usageError } from '../utils/usage-query'
import { AdminUsageController } from './usage.controller'

describe('AdminUsageController HTTP contract', () => {
  let app: INestApplication
  let base: string
  const query = jest.fn().mockResolvedValue({ items: [] })
  const valid = 'from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z'
  const get = (params = valid, headers: Record<string, string> = {}) =>
    fetch(`${base}?${params}`, { headers: { authorization: 'Bearer admin', ...headers } })

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AdminUsageController],
      providers: [{ provide: AdminUsageService, useValue: { query } }],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest()
          if (!req.headers.authorization) throw new UnauthorizedException()
          req.user = {
            role: req.headers.authorization === 'Bearer admin' ? SystemRole.ADMIN : SystemRole.USER,
            userId: 'test-admin',
          }
          return true
        },
      })
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalFilters(new AllExceptionsFilter({ incrementFailedAuth: jest.fn() } as never))
    await app.listen(0)
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/admin/usage`
  })
  afterAll(async () => app.close())
  beforeEach(() => query.mockClear())

  it('normalizes timezone, sets and defaults while retaining real administrator role authorization', async () => {
    const response = await get(`${valid}&groupBy=boxId,organizationId&metrics=memoryGibSeconds,computeVcpuSeconds`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(query).toHaveBeenCalledWith(
      {
        limit: 50,
        query: {
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-01-02T00:00:00.000Z',
          granularity: 'window',
          groupBy: ['organizationId', 'boxId'],
          metrics: ['computeVcpuSeconds', 'memoryGibSeconds'],
        },
      },
      expect.objectContaining({ userId: 'test-admin' }),
      undefined,
    )
    expect((await get(valid, { authorization: 'Bearer user' })).status).toBe(403)
    expect((await fetch(`${base}?${valid}`)).status).toBe(401)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it.each([
    '',
    'from=2026-02-30T00:00:00Z&to=2026-03-01T00:00:00Z',
    'from=2026-01-01&to=2026-01-02',
    'from=2026-01-01T00:00:00.0001Z&to=2026-01-02T00:00:00Z',
    'from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z',
    'from=9999-01-01T00:00:00Z&to=9999-01-02T00:00:00Z',
    'from=2026-01-01T00:00:00Z&to=2026-01-09T00:00:00Z&granularity=hour',
    'from=2026-01-01T00:00:00Z&to=2026-05-01T00:00:00Z',
    ...[
      'from=x',
      'unknown=x',
      'limit=0',
      'limit=201',
      'limit=1e2',
      'granularity=month',
      'metrics=',
      'metrics=cost',
      'metrics=computeVcpuSeconds,computeVcpuSeconds',
      'metrics=computeVcpuSeconds&metrics=storageByteSeconds',
      'groupBy=organizationId,regionId,boxId',
      'groupBy=organizationId,organizationId',
      'organizationId=invalid',
      'regionId=%20sgp',
      'boxId=box%2Fsecret',
      `regionId=${'a'.repeat(129)}`,
      `cursor=${'a'.repeat(2049)}`,
    ].map((suffix) => `${valid}&${suffix}`),
  ])('rejects invalid query before calling the source: %s', async (params) => {
    const response = await get(params)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      statusCode: 400,
      code: 'invalid_usage_query',
      message: 'Invalid usage query',
    })
    expect(query).not.toHaveBeenCalled()
  })

  it('validates optional owner partition and preserves known source errors', async () => {
    expect((await get(valid, { 'X-Usage-Snapshot-Owner': 'not-a-partition' })).status).toBe(400)
    expect(query).not.toHaveBeenCalled()
    for (const status of [400, 410, 422, 503] as const) {
      query.mockRejectedValueOnce(usageError(status))
      const response = await get(valid, { 'X-Usage-Snapshot-Owner': 'a'.repeat(64) })
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject(usageError(status).getResponse())
    }
  })

  it('exports explicit query and typed metric/coverage/error schemas for both generated clients', () => {
    const spec = SwaggerModule.createDocument(app, new DocumentBuilder().addBearerAuth().build())
    const operation = spec.paths['/api/admin/usage'].get
    expect(operation?.operationId).toBe('adminQueryUsage')
    for (const name of ['from', 'to', 'metrics', 'groupBy', 'organizationId', 'regionId', 'boxId', 'cursor'])
      expect(operation?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name, schema: expect.objectContaining({ type: 'string' }) }),
        ]),
      )
    expect(spec.components?.schemas?.AdminUsageValues).toMatchObject({
      properties: {
        memoryGibSeconds: { type: 'string' },
        computeVcpuSeconds: { type: 'string' },
        storageByteSeconds: { type: 'string' },
      },
    })
    expect(spec.components?.schemas?.AdminUsageCoverage).toMatchObject({
      properties: { status: { enum: ['unknown'] } },
    })
    expect(operation?.responses?.['503']).toMatchObject({
      content: { 'application/json': { schema: { $ref: '#/components/schemas/AdminUsageError' } } },
    })
  })
})
