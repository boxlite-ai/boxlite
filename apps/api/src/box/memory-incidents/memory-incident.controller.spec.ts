import { ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { AddressInfo } from 'net'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { AdminRunnerMemoryIncidentController, RunnerMemoryIncidentController } from './memory-incident.controller'
import { MemoryIncidentService } from './memory-incident.service'

const runnerId = '11111111-1111-4111-8111-111111111111'
const range = { from: '2026-10-29T00:00:00Z', to: '2026-10-30T00:00:00Z' }
const report = {
  eventId: '22222222-2222-4222-8222-222222222222',
  sampledAt: '2026-10-29T00:00:00Z',
  runnerMemoryPercent: 80.1,
  boxes: [{ boxId: 'business-box', image: 'ubuntu:24.04', memoryBytes: '9007199254740993' }],
  samplingComplete: true,
}

describe('Memory incident HTTP contract', () => {
  let app: INestApplication
  let base: string
  const record = jest.fn().mockResolvedValue(undefined)
  const list = jest.fn().mockResolvedValue({ items: [] })
  const post = (body: unknown = report, role = 'runner') =>
    fetch(`${base}/runners/me/memory-incidents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${role}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const get = (query = '', role = 'admin', timeRange: Record<string, string> = range) =>
    fetch(`${base}/admin/runner-memory-incidents?${new URLSearchParams(timeRange)}&${query.replace(/^\?/, '')}`, {
      headers: role ? { authorization: `Bearer ${role}` } : {},
    })

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [RunnerMemoryIncidentController, AdminRunnerMemoryIncidentController],
      providers: [{ provide: MemoryIncidentService, useValue: { record, list } }],
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
    { boxes: null },
    { boxes: {} },
    { boxes: [null] },
    { boxes: [123] },
    { boxes: undefined },
    { boxes: Array.from({ length: 6 }, (_, i) => ({ ...report.boxes[0], boxId: `box-${i}` })) },
    { boxes: [report.boxes[0], report.boxes[0]] },
    { eventId: 'bad' },
    { runnerMemoryPercent: 101 },
    { runnerMemoryPercent: 79.9 },
    { sampledAt: 'bad' },
    { sampledAt: '2026-10-29T00:00:00' },
    { samplingComplete: 'true' },
    { samplingComplete: undefined },
  ])('rejects malformed upload %j', async (extra) => {
    expect((await post({ ...report, ...extra })).status).toBe(400)
    expect(record).not.toHaveBeenCalled()
  })

  it('accepts explicit unavailable attribution', async () => {
    expect((await post({ ...report, boxes: [], samplingComplete: false })).status).toBe(204)
  })

  it.each(['registry.example/team/image:tag', ''])('accepts image %j without another lookup', async (image) => {
    const body = { ...report, boxes: [{ ...report.boxes[0], image }] }
    expect((await post(body)).status).toBe(204)
    expect(record).toHaveBeenCalledWith(runnerId, body)
  })

  it.each([
    { boxId: '../other' },
    { boxId: undefined },
    { image: null },
    { image: 123 },
    { image: undefined },
    { memoryBytes: -1 },
    { memoryBytes: '01' },
    { memoryBytes: '-1' },
    { memoryBytes: '1.5' },
    { memoryBytes: '1e9' },
    { memoryBytes: '12345678901234567890' },
    { memoryBytes: undefined },
    { extra: true },
  ])('validates nested Box usage %j', async (extra) => {
    expect((await post({ ...report, boxes: [{ ...report.boxes[0], ...extra }] })).status).toBe(400)
    expect(record).not.toHaveBeenCalled()
  })

  it('accepts exactly five ranked Boxes and invokes semantic validation', async () => {
    const body = {
      ...report,
      boxes: Array.from({ length: 5 }, (_, i) => ({ boxId: `box-${i}`, image: '', memoryBytes: String(5 - i) })),
    }
    expect((await post(body)).status).toBe(204)
    expect(record).toHaveBeenCalledWith(runnerId, body)
    record.mockImplementationOnce((id, dto) => new MemoryIncidentService(null).record(id, dto))
    expect((await post({ ...body, runnerMemoryPercent: 80 })).status).toBe(400)
  })

  it.each([
    [{ ...report.boxes[0], memoryBytes: '9223372036854775808' }],
    [
      { boxId: 'a', image: '', memoryBytes: '1' },
      { boxId: 'b', image: '', memoryBytes: '2' },
    ],
    [
      { boxId: 'b', image: '', memoryBytes: '1' },
      { boxId: 'a', image: '', memoryBytes: '1' },
    ],
  ])('rejects incoherent byte range or ranking %#', async (...boxes) => {
    record.mockImplementationOnce((id, dto) => new MemoryIncidentService(null).record(id, dto))
    expect((await post({ ...report, boxes })).status).toBe(400)
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
    list.mockImplementationOnce((query) => new MemoryIncidentService(null).list(query))
    expect((await get('', 'admin', { ...range, to })).status).toBe(400)
  })

  it.each(['?afterId=0', '?limit=0', '?limit=201', '?limit=1.5', '?runnerId=bad', '?unknown=x'])(
    'rejects invalid query %s',
    async (query) => {
      expect((await get(query)).status).toBe(400)
      expect(list).not.toHaveBeenCalled()
    },
  )

  it('documents Memory incident limit as a bounded integer', () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().addBearerAuth().build())
    const operation = document.paths['/api/admin/runner-memory-incidents'].get
    expect(operation.parameters.find((parameter) => 'name' in parameter && parameter.name === 'limit')).toMatchObject({
      required: false,
      schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    })
  })

  it('documents admin responses and keeps ingestion out of customer OpenAPI', () => {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().addBearerAuth().build())
    expect(document.paths['/api/runners/me/memory-incidents']).toBeUndefined()
    const operation = document.paths['/api/admin/runner-memory-incidents'].get
    expect(operation.operationId).toBe('adminListRunnerMemoryIncidents')
    expect(operation.responses['200']).toBeDefined()
    expect(operation.parameters.map((parameter) => ('name' in parameter ? parameter.name : undefined))).toEqual([
      'from',
      'to',
      'limit',
      'runnerId',
    ])
    const responseSchema = document.components.schemas.MemoryIncidentListDto
    const properties = responseSchema && 'properties' in responseSchema ? responseSchema.properties : undefined
    expect(properties).toEqual({ items: expect.any(Object) })
    const incidentSchema = document.components.schemas.RunnerMemoryIncident
    expect(
      incidentSchema && 'properties' in incidentSchema ? incidentSchema.properties.boxes : undefined,
    ).toMatchObject({
      type: 'array',
      maxItems: 5,
    })
    for (const name of ['from', 'to']) {
      expect(operation.parameters.find((parameter) => 'name' in parameter && parameter.name === name)).toMatchObject({
        required: true,
        schema: { type: 'string', format: 'date-time' },
      })
    }
  })
})
