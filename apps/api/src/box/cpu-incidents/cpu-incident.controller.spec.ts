import { ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { AddressInfo } from 'net'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { AdminRunnerCpuIncidentController, RunnerCpuIncidentController } from './cpu-incident.controller'
import { CpuIncidentService } from './cpu-incident.service'

const runnerId = '11111111-1111-4111-8111-111111111111'
const range = { from: '2026-10-29T00:00:00Z', to: '2026-10-30T00:00:00Z' }
const report = {
  eventId: '22222222-2222-4222-8222-222222222222',
  highCpuSince: '2026-10-29T00:00:00Z',
  windowStartedAt: '2026-10-29T00:05:00Z',
  windowEndedAt: '2026-10-29T00:07:00Z',
  runnerCpuPercent: 80.1,
  boxId: 'business-box',
  cpuSeconds: 240,
  samplingComplete: true,
}

describe('CPU incident HTTP contract', () => {
  let app: INestApplication
  let base: string
  const record = jest.fn().mockResolvedValue(undefined)
  const list = jest.fn().mockResolvedValue({ items: [] })
  const post = (body: unknown = report, role = 'runner') =>
    fetch(`${base}/runners/me/cpu-incidents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${role}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const get = (query = '', role = 'admin', timeRange: Record<string, string> = range) =>
    fetch(`${base}/admin/runner-cpu-incidents?${new URLSearchParams(timeRange)}&${query.replace(/^\?/, '')}`, {
      headers: role ? { authorization: `Bearer ${role}` } : {},
    })

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [RunnerCpuIncidentController, AdminRunnerCpuIncidentController],
      providers: [{ provide: CpuIncidentService, useValue: { record, list } }],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const request = context.switchToHttp().getRequest()
          if (!request.headers.authorization) throw new UnauthorizedException()
          request.user = { role: request.headers.authorization.slice(7), runnerId }
          return true
        },
      })
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    await app.listen(0, '127.0.0.1')
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api`
  })
  afterAll(async () => app.close())
  beforeEach(() => jest.clearAllMocks())

  it('binds uploads to authenticated runner and retains real role guards', async () => {
    expect((await post()).status).toBe(204)
    expect(record).toHaveBeenCalledWith(runnerId, report)
    expect((await post(report, 'user')).status).toBe(401)
    expect((await post(report, 'admin')).status).toBe(401)
    expect((await get('', 'user')).status).toBe(403)
    expect((await get('', 'runner')).status).toBe(403)
    expect((await get('', '')).status).toBe(401)
    expect(record).toHaveBeenCalledTimes(1)
    expect(list).not.toHaveBeenCalled()
  })

  it.each([
    { runnerId: 'spoofed' },
    { image: 123 },
    { image: { name: 'invalid' } },
    { eventId: 'bad' },
    { cpuSeconds: -1 },
    { cpuSeconds: '2' },
    { runnerCpuPercent: 101 },
    { runnerCpuPercent: 79.9 },
    { highCpuSince: 'bad' },
    { boxId: '../other' },
    { boxId: undefined },
    { samplingComplete: 'true' },
    { samplingComplete: undefined },
  ])('rejects malformed upload %j', async (extra) => {
    expect((await post({ ...report, ...extra })).status).toBe(400)
    expect(record).not.toHaveBeenCalled()
  })

  it('accepts explicit unavailable attribution', async () => {
    expect((await post({ ...report, boxId: null, cpuSeconds: 0, samplingComplete: false })).status).toBe(204)
  })

  it.each(['registry.example/team/image:tag', '', null])('accepts image %j without another lookup', async (image) => {
    const body = { ...report, image }
    expect((await post(body)).status).toBe(204)
    expect(record).toHaveBeenCalledWith(runnerId, body)
  })

  it('applies the bounded limit and runner filter without cursor parameters', async () => {
    const response = await get('?limit=2&runnerId=' + runnerId)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(list).toHaveBeenCalledWith({ ...range, limit: 2, runnerId })
    await get()
    expect(list).toHaveBeenLastCalledWith({ ...range, limit: 50 })
  })

  it.each([
    {},
    { from: range.from },
    { to: range.to },
    { ...range, from: '2026-10-29' },
    { ...range, to: '2026-10-30T00:00:00' },
    { ...range, from: '2026-02-30T00:00:00Z' },
    { ...range, to: '2026-10-30T00:00:00.1234Z' },
  ])('requires a valid timezone-bearing time range %j', async (timeRange) => {
    expect((await get('', 'admin', timeRange)).status).toBe(400)
    expect(list).not.toHaveBeenCalled()
  })

  it.each([range.from, '2026-10-28T00:00:00Z'])('rejects non-increasing range ending %s', async (to) => {
    list.mockImplementationOnce((query) => new CpuIncidentService(null).list(query))
    expect((await get('', 'admin', { ...range, to })).status).toBe(400)
  })

  it.each(['?afterId=0', '?limit=0', '?limit=201', '?limit=1.5', '?runnerId=bad', '?unknown=x'])(
    'rejects invalid query %s',
    async (query) => {
      expect((await get(query)).status).toBe(400)
      expect(list).not.toHaveBeenCalled()
    },
  )

  it('documents CPU incident limit as a bounded integer', () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().addBearerAuth().build())
    const operation = document.paths['/api/admin/runner-cpu-incidents'].get
    expect(operation.parameters.find((parameter) => 'name' in parameter && parameter.name === 'limit')).toMatchObject({
      required: false,
      schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    })
  })

  it('documents admin responses and keeps ingestion out of customer OpenAPI', () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().addBearerAuth().build())
    expect(document.paths['/api/runners/me/cpu-incidents']).toBeUndefined()
    const operation = document.paths['/api/admin/runner-cpu-incidents'].get
    expect(operation.operationId).toBe('adminListRunnerCpuIncidents')
    expect(operation.responses['200']).toBeDefined()
    expect(operation.parameters.map((parameter) => ('name' in parameter ? parameter.name : undefined))).toEqual([
      'from',
      'to',
      'limit',
      'runnerId',
    ])
    const responseSchema = document.components.schemas.CpuIncidentListDto
    const properties = responseSchema && 'properties' in responseSchema ? responseSchema.properties : undefined
    expect(properties).toEqual({ items: expect.any(Object) })
    const incidentSchema = document.components.schemas.RunnerCpuIncident
    expect(
      incidentSchema && 'properties' in incidentSchema ? incidentSchema.properties.image : undefined,
    ).toMatchObject({
      type: 'string',
      nullable: true,
    })
    for (const name of ['from', 'to']) {
      expect(operation.parameters.find((parameter) => 'name' in parameter && parameter.name === name)).toMatchObject({
        required: true,
        schema: { type: 'string', format: 'date-time' },
      })
    }
  })
})
