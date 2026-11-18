/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Duplex, PassThrough } from 'node:stream'
import { text } from 'node:stream/consumers'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import { ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import axios, { AxiosError } from 'axios'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { Box } from '../box/entities/box.entity'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxService } from '../box/services/box.service'
import { RunnerService } from '../box/services/runner.service'
import { emitTiming, resetTimingForTest, snapshotTiming, startTiming } from '../common/utils/tti-timing.util'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationService } from '../organization/services/organization.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { SystemRole } from '../user/enums/system-role.enum'
import { BoxliteTimingController } from './boxlite-timing.controller'

const boxId = 'AbCdEf123456'
const organizationId = 'org-1'
const event = {
  op: 'exec',
  stage: 'exec.run',
  status: 'ok',
  dur_ms: 15,
  box_id: boxId,
  job_id: 'job-1',
  exec_id: 'exec-1',
  ts: '2026-11-18T06:00:00Z',
}
const runner = { apiUrl: 'https://runner.test/', proxyUrl: 'https://proxy.test', apiKey: 'runner-key' }

function runnerError(code: string, status?: number) {
  return Object.assign(new AxiosError('private runner message', code), {
    response: status === undefined ? undefined : { status, data: 'private runner body', headers: { 'x-private': '1' } },
  })
}

// Run the real Nest HTTP routing and response handling over streams, without a listening socket.
async function get(app: INestApplication, id: string, token = organizationId) {
  const input = new PassThrough()
  const output = new PassThrough()
  const socket = Duplex.from({ readable: input, writable: output })
  app.getHttpServer().emit('connection', socket)
  const result = text(output)
  input.write(
    `GET /api/timing/${id} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nCookie: user=session\r\nConnection: close\r\n\r\n`,
  )
  try {
    const [headers, body] = (await result).split('\r\n\r\n')
    return { status: Number(headers.split(' ')[1]), headers: headers.toLowerCase(), body: JSON.parse(body) }
  } finally {
    socket.destroy()
  }
}

describe('BoxliteTimingController', () => {
  let app: INestApplication
  let box: Partial<Box> & { deletedAt?: Date }
  let axiosGet: jest.SpiedFunction<typeof axios.get>
  const boxRepository = {
    findOne: jest.fn(async ({ where, withDeleted }: { where: Partial<Box>; withDeleted?: boolean }) => {
      return (!box.deletedAt || withDeleted) && Object.entries(where).every(([key, value]) => box[key] === value)
        ? box
        : null
    }),
  }
  const runnerService = { findOne: jest.fn() }

  beforeAll(async () => {
    const boxService = Object.assign(Object.create(BoxService.prototype), { boxRepository })
    const module = await Test.createTestingModule({
      controllers: [BoxliteTimingController],
      providers: [
        { provide: BoxService, useValue: boxService },
        { provide: RunnerService, useValue: runnerService },
        { provide: getRedisConnectionToken(), useValue: { get: async () => null, set: async () => undefined } },
        { provide: OrganizationService, useValue: { findOne: async (id: string) => ({ id }) } },
        {
          provide: OrganizationUserService,
          useValue: { findOne: async () => ({ role: OrganizationMemberRole.MEMBER }) },
        },
      ],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const req = context.switchToHttp().getRequest()
          const token = req.headers.authorization?.slice('Bearer '.length)
          if (token !== organizationId && token !== 'org-2') throw new UnauthorizedException()
          req.user = { role: SystemRole.USER, userId: 'user-1', organizationId: token }
          return true
        },
      })
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    await app.init()
  })

  afterAll(async () => {
    await app?.close()
  })

  beforeEach(() => {
    boxRepository.findOne.mockClear()
    runnerService.findOne.mockReset().mockResolvedValue(runner)
    axiosGet = jest.spyOn(axios, 'get').mockResolvedValue({ data: { box_id: boxId, events: [event] } })
    box = { id: boxId, name: 'friendly-name', organizationId, runnerId: 'runner-1' }
    resetTimingForTest()
    emitTiming('create', 'create.request', 'ok', startTiming(), { box_id: boxId })
  })

  afterEach(() => {
    jest.restoreAllMocks()
    resetTimingForTest()
  })

  function expectTiming(
    response: Awaited<ReturnType<typeof get>>,
    runner_status: string,
    runnerEvents: unknown[] = [],
  ) {
    expect(response.status).toBe(200)
    expect(response.headers).toContain('cache-control: no-store')
    expect(response.headers).not.toContain('x-private')
    const api = snapshotTiming(boxId)
    expect(api).toHaveLength(1)
    expect(response.body).toEqual({ box_id: boxId, api, runner: runnerEvents, runner_status })
  }

  it('joins local timing with one authenticated runner GET and does not forward caller headers', async () => {
    box.prevRunnerId = 'older-runner'
    expectTiming(await get(app, boxId), 'ok', [event])
    expect(runnerService.findOne).toHaveBeenCalledWith('runner-1')
    expect(axiosGet).toHaveBeenCalledTimes(1)
    expect(axiosGet).toHaveBeenCalledWith('https://runner.test/timing/AbCdEf123456', {
      headers: { Authorization: 'Bearer runner-key' },
      timeout: 3000,
      maxRedirects: 0,
    })
  })

  it.each([
    ['unreachable', runnerError('ECONNREFUSED'), 'unavailable'],
    ['5xx', runnerError('ERR_BAD_RESPONSE', 503), 'unavailable'],
    ['timeout', runnerError('ECONNABORTED'), 'timeout'],
    ['socket timeout', runnerError('ETIMEDOUT'), 'timeout'],
    ['401', runnerError('ERR_BAD_REQUEST', 401), 'auth_error'],
    ['403', runnerError('ERR_BAD_REQUEST', 403), 'auth_error'],
  ])('keeps API history and does not retry on runner %s', async (_, error, status) => {
    axiosGet.mockRejectedValue(error)
    expectTiming(await get(app, boxId), status)
    expect(axiosGet).toHaveBeenCalledTimes(1)
  })

  it('keeps API history when neither runner ID is set', async () => {
    box.runnerId = null
    expectTiming(await get(app, boxId), 'no_runner')
    expect(runnerService.findOne).not.toHaveBeenCalled()
    expect(axiosGet).not.toHaveBeenCalled()
  })

  it('returns uniform 404s for a foreign box, an unknown ID, or a box name without looking up a runner', async () => {
    const foreign = await get(app, boxId, 'org-2')
    const missing = await get(app, 'ZZZZZZZZZZZZ')
    const byName = await get(app, box.name)
    expect([foreign.status, missing.status, byName.status]).toEqual([404, 404, 404])
    expect(foreign.body).toEqual(missing.body)
    expect(byName.body).toEqual(missing.body)
    expect(boxRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: boxId, organizationId: 'org-2' } }),
    )
    expect(runnerService.findOne).not.toHaveBeenCalled()
    expect(axiosGet).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated access before looking up the box', async () => {
    expect((await get(app, boxId, 'invalid-token')).status).toBe(401)
    expect(boxRepository.findOne).not.toHaveBeenCalled()
    expect(axiosGet).not.toHaveBeenCalled()
  })

  it('strips unknown fields and preserves omitted correlation IDs', async () => {
    const { box_id, job_id, exec_id, ...withoutIds } = event
    axiosGet.mockResolvedValue({
      data: { box_id, events: [{ ...event, source: 'private' }, withoutIds], internal: 'private' },
    })
    expectTiming(await get(app, boxId), 'ok', [event, withoutIds])
  })

  it('omits empty and null correlation IDs from runner events', async () => {
    const { job_id, exec_id, ...withoutIds } = event
    axiosGet.mockResolvedValue({ data: { box_id: boxId, events: [{ ...event, job_id: '', exec_id: null }] } })
    expectTiming(await get(app, boxId), 'ok', [withoutIds])
  })

  it.each([
    ['a mismatched box_id', { box_id: 'other-box', events: [event] }],
    ['a mismatched event box_id', { box_id: boxId, events: [{ ...event, box_id: 'other-box' }] }],
    ['a malformed event', { box_id: boxId, events: [{ ...event, stage: { private: 'value' } }] }],
    ['missing events', { box_id: boxId }],
    ['an unparsed response', '<html>private runner body</html>'],
  ])('keeps API history and discards the runner response with %s', async (_, data) => {
    axiosGet.mockResolvedValue({ data })
    expectTiming(await get(app, boxId), 'unavailable')
  })

  it('includes deleted boxes and uses the previous runner and its proxy URL when needed', async () => {
    Object.assign(box, { state: BoxState.DESTROYED, deletedAt: new Date(), runnerId: null, prevRunnerId: 'old-runner' })
    runnerService.findOne.mockResolvedValue({ ...runner, apiUrl: null })
    expectTiming(await get(app, boxId), 'ok', [event])
    expect(boxRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: boxId, organizationId }, withDeleted: true }),
    )
    expect(runnerService.findOne).toHaveBeenCalledWith('old-runner')
    expect(axiosGet).toHaveBeenCalledWith('https://proxy.test/timing/AbCdEf123456', expect.any(Object))
  })
})
