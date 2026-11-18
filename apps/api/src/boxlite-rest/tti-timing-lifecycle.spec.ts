/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { EventEmitter } from 'node:events'
import { ConflictException, GatewayTimeoutException, NotFoundException } from '@nestjs/common'
import { HTTP_CODE_METADATA } from '@nestjs/common/constants'
import { createProxyMiddleware } from 'http-proxy-middleware'
import { JobType, ResourceType } from '../box/dto/job.dto'
import { BoxDesiredState } from '../box/enums/box-desired-state.enum'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxService } from '../box/services/box.service'
import { JobService } from '../box/services/job.service'
import { Context } from '../common/context/context'
import * as timing from '../common/utils/tti-timing.util'
import { BoxliteBoxController } from './boxlite-box.controller'
import { BoxliteProxyController } from './boxlite-proxy.controller'
import { BoxliteTimingController } from './boxlite-timing.controller'
import { boxToBoxResponse } from './mappers/box-to-box.mapper'

jest.mock('http-proxy-middleware', () => ({ createProxyMiddleware: jest.fn(), fixRequestBody: jest.fn() }))

const boxId = 'box-1'
const boxName = 'friendly-name'
const organization = { id: 'org-1' }
const auth = { organization, organizationId: organization.id } as never
const otherAuth = { organization: { id: 'org-2' }, organizationId: 'org-2' } as never
const deniedLookups = [
  ['a foreign box ID', boxId, otherAuth],
  ['an unknown box ID', 'unknown-box', auth],
] as const
const ctx = Context.user()
const dto = { image: 'boxlite/base' } as never
const started = {
  id: boxId,
  state: BoxState.STARTED,
  image: 'boxlite/base',
  createdAt: '2026-09-30T08:00:00.000Z',
  updatedAt: '2026-09-30T08:00:00.000Z',
}

function boxHarness() {
  const boxService = {
    create: jest.fn().mockImplementation(async () => {
      jest.advanceTimersByTime(20)
      return { ...started, state: BoxState.CREATING }
    }),
    destroy: jest.fn().mockResolvedValue(started),
  }
  const waitForStarted = jest.fn().mockImplementation(async () => {
    jest.advanceTimersByTime(7)
    return started
  })
  const controller = new BoxliteBoxController(
    boxService as never,
    { waitForStarted } as never,
    { resolveMaxCreatedBoxes: jest.fn().mockResolvedValue(3) } as never,
    {} as never,
  )
  const res = Object.assign(new EventEmitter(), { statusCode: 201 })
  const create = () => controller.createBox(auth, dto, ctx, { res } as never)
  return { controller, boxService, waitForStarted, create, res }
}

function scopedBoxService() {
  const box = {
    ...started,
    name: boxName,
    organizationId: organization.id,
    runnerId: 'runner-1',
    desiredState: BoxDesiredState.STARTED,
  }
  const boxService: BoxService = Object.assign(Object.create(BoxService.prototype), {
    boxRepository: {
      findOne: async ({ where }: { where: { id?: string; name?: string; organizationId: string } }) => {
        jest.advanceTimersByTime(20)
        const { id, name, organizationId } = where
        return organizationId === box.organizationId && (id === box.id || name === box.name) ? box : null
      },
    },
    updateLastActivityAt: jest.fn().mockResolvedValue(undefined),
  })
  return { box, boxService }
}

function proxyHarness() {
  const { box, boxService } = scopedBoxService()
  const controller = new BoxliteProxyController(
    boxService,
    { findOne: jest.fn().mockResolvedValue({ apiUrl: 'http://runner.local' }) } as never,
    {} as never,
    {} as never,
  )
  const res = Object.assign(new EventEmitter(), { statusCode: 201 })
  const req = { method: 'POST', url: '/exec' }
  jest.mocked(createProxyMiddleware).mockImplementation((options) => {
    return jest.fn(async () => {
      options.on?.start?.(req as never, res as never, 'http://runner.local')
    }) as never
  })
  const forward = (statusCode: number, location?: string) => {
    const options = jest.mocked(createProxyMiddleware).mock.lastCall![0]
    options.on?.proxyRes?.({ statusCode, headers: { location } } as never, req as never, res as never)
  }
  const timingController = new BoxliteTimingController(boxService, { findOne: async () => null } as never)
  return {
    box,
    boxService,
    res,
    forward,
    exec: (id = boxId, caller = auth) => controller.proxyExec(caller, id, req as never, res as never, jest.fn()),
    getTiming: (id: string) => timingController.getTiming(auth, id),
  }
}

const events = () => timing.snapshotTiming(boxId)
const event = (op: string, stage: string, status: string, dur_ms?: number) =>
  expect.objectContaining({ op, stage, status, box_id: boxId, ...(dur_ms === undefined ? {} : { dur_ms }) })

beforeEach(() => {
  jest.useFakeTimers()
  timing.resetTimingForTest()
})

afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
})

describe.each([false, true])('TTI lifecycle (emitTiming throws: %s)', (emitThrows) => {
  let emit: jest.SpiedFunction<typeof timing.emitTiming>

  beforeEach(() => {
    emit = jest.spyOn(timing, 'emitTiming')
    if (emitThrows) {
      emit.mockImplementation(() => {
        throw new Error('probe failure')
      })
    }
  })

  it('times the create wait and the completed HTTP response separately', async () => {
    const { create, waitForStarted, res } = boxHarness()
    await expect(create()).resolves.toEqual(boxToBoxResponse(started as never))
    expect(waitForStarted).toHaveBeenCalledWith(boxId, organization.id, 30)
    expect(emit).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(3)
    res.emit('finish')
    res.emit('close')
    expect(res.statusCode).toBe(Reflect.getMetadata(HTTP_CODE_METADATA, BoxliteBoxController.prototype.createBox))
    expect(emit).toHaveBeenCalledTimes(2)
    expect(events()).toEqual(
      emitThrows ? [] : [event('create', 'create.wait_started', 'ok', 7), event('create', 'create.request', 'ok', 30)],
    )
  })

  it('records a startup timeout without replacing the original exception', async () => {
    const { create, waitForStarted, res } = boxHarness()
    const error = new GatewayTimeoutException('start timed out')
    waitForStarted.mockRejectedValue(error)
    await expect(create()).rejects.toBe(error)
    res.statusCode = error.getStatus()
    res.emit('finish')
    expect(res.statusCode).toBe(504)
    expect(emit).toHaveBeenCalledTimes(2)
    expect(events()).toEqual(
      emitThrows ? [] : [event('create', 'create.wait_started', 'error'), event('create', 'create.request', 'error')],
    )
  })

  it('times a successful destroy without changing the return value', async () => {
    const { controller, boxService } = boxHarness()
    boxService.destroy.mockImplementationOnce(async () => jest.advanceTimersByTime(5))
    await expect(controller.removeBox(auth, boxId, ctx)).resolves.toBeUndefined()
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('destroy', 'destroy.request', 'ok', expect.any(BigInt), { box_id: boxId })
    expect(events()).toEqual(emitThrows ? [] : [event('destroy', 'destroy.request', 'ok', 5)])
  })

  it('times forwarding and the HTTP response under the canonical ID when exec targets a name', async () => {
    const { exec, forward, getTiming, res } = proxyHarness()
    await expect(exec(boxName)).resolves.toBeUndefined()
    expect(emit).not.toHaveBeenCalled()
    jest.advanceTimersByTime(7)
    forward(201, '/v1/boxes/box-1/executions/exec-1')
    expect(emit).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(3)
    res.emit('finish')
    res.emit('close')
    expect(res.statusCode).toBe(201)
    expect(emit).toHaveBeenCalledTimes(2)
    const { api } = await getTiming(boxId)
    expect(api).toEqual(
      emitThrows ? [] : [event('exec', 'exec.forwarded', 'ok', 7), event('exec', 'exec.request', 'ok', 50)],
    )
    expect(api.map(({ exec_id }) => exec_id)).toEqual(emitThrows ? [] : ['exec-1', 'exec-1'])
    expect(timing.snapshotTiming(boxName)).toEqual([])
  })

  it('records a create job at insert, before the tolerated Redis notification failure', async () => {
    const insert = jest.fn().mockImplementation(async () => jest.advanceTimersByTime(5))
    const redis = {
      lpush: jest.fn().mockImplementation(async () => {
        jest.advanceTimersByTime(10)
        throw new Error('Redis unavailable')
      }),
    }
    const service = new JobService({ insert } as never, redis as never, {} as never)
    const job = await service.createJob(null, JobType.CREATE_BOX, 'runner-1', ResourceType.BOX, boxId)
    expect(insert).toHaveBeenCalledWith(job)
    expect(redis.lpush).toHaveBeenCalledWith(expect.any(String), job.id)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(events()).toEqual(emitThrows ? [] : [event('create', 'create.job_inserted', 'ok', 5)])
    if (!emitThrows) expect(events()[0].job_id).toBe(job.id)
  })
})

it('keeps the delete return value and declared 204 without a response hook', async () => {
  const emit = jest.spyOn(timing, 'emitTiming')
  jest.spyOn(timing, 'startTiming').mockReturnValueOnce(undefined)
  const { controller, boxService } = boxHarness()
  await expect(controller.removeBox(auth, boxId, ctx)).resolves.toBeUndefined()
  expect(boxService.destroy).toHaveBeenCalledWith(boxId, organization.id, ctx)
  expect(Reflect.getMetadata(HTTP_CODE_METADATA, BoxliteBoxController.prototype.removeBox)).toBe(204)
  expect(emit).not.toHaveBeenCalled()
})

it.each(deniedLookups)('does not add timing when destroy rejects %s', async (_, id, caller) => {
  const { controller, boxService } = boxHarness()
  const { boxService: scopedService } = scopedBoxService()
  boxService.destroy.mockImplementationOnce(scopedService.destroy.bind(scopedService))
  timing.emitTiming('create', 'create.request', 'ok', timing.startTiming(), { box_id: boxId })
  const before = timing.snapshotTiming(id)

  await expect(controller.removeBox(caller, id, ctx)).rejects.toBeInstanceOf(NotFoundException)
  expect(timing.snapshotTiming(id)).toEqual(before)
})

it.each(deniedLookups)('does not add timing when exec rejects %s', async (_, id, caller) => {
  const { exec, res } = proxyHarness()
  timing.emitTiming('create', 'create.request', 'ok', timing.startTiming(), { box_id: boxId })
  const before = timing.snapshotTiming(id)

  await expect(exec(id, caller)).rejects.toBeInstanceOf(NotFoundException)
  res.statusCode = 404
  res.emit('finish')
  res.emit('close')
  expect(timing.snapshotTiming(id)).toEqual(before)
})

it('does not add timing when exec is denied before forwarding', async () => {
  const { box, exec, res } = proxyHarness()
  box.state = BoxState.STOPPED
  await expect(exec()).rejects.toBeInstanceOf(ConflictException)
  res.statusCode = 409
  res.emit('finish')
  expect(events()).toEqual([])
})

it('records a premature close once and skips the wait for an already running box', async () => {
  const { create, boxService, waitForStarted, res } = boxHarness()
  boxService.create.mockResolvedValue(started)
  await create()
  res.emit('close')
  res.emit('finish')
  expect(waitForStarted).not.toHaveBeenCalled()
  expect(events()).toEqual([event('create', 'create.request', 'error')])
})

it('attempts to record create failure without inventing a box ID', async () => {
  const emit = jest.spyOn(timing, 'emitTiming')
  const { create, boxService, res } = boxHarness()
  const error = new Error('create failed')
  boxService.create.mockRejectedValue(error)
  await expect(create()).rejects.toBe(error)
  res.statusCode = 500
  res.emit('finish')
  expect(emit).toHaveBeenCalledWith('create', 'create.request', 'error', expect.any(BigInt), {})
})

it.each([
  ['upstream 5xx', 503, true],
  ['gateway timeout', 504, false],
])('records %s as a forwarding and request error', async (_, statusCode, hasHeaders) => {
  const { exec, forward, res } = proxyHarness()
  await exec()
  if (hasHeaders) forward(statusCode)
  res.statusCode = statusCode
  res.emit('finish')
  res.emit('close')
  expect(events()).toEqual([event('exec', 'exec.forwarded', 'error'), event('exec', 'exec.request', 'error')])
})

it('times exec only until a close that precedes box lookup completion', async () => {
  const { box, boxService, exec, res } = proxyHarness()
  const emit = jest.spyOn(timing, 'emitTiming')
  jest
    .spyOn(boxService, 'findOneByIdOrName')
    .mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(box as never), 500)))

  const request = exec(boxName)
  jest.advanceTimersByTime(5)
  Object.assign(res, { destroyed: true })
  res.emit('close')
  expect(emit).not.toHaveBeenCalled()

  jest.advanceTimersByTime(495)
  await request
  res.emit('finish')
  expect(events()).toEqual([event('exec', 'exec.request', 'error', 5)])
  expect(timing.snapshotTiming(boxName)).toEqual([])
})

it('records an interrupted upstream request once without fabricating an execution ID', async () => {
  const { exec, res } = proxyHarness()
  await exec()
  res.emit('close')
  res.emit('finish')
  expect(events()).toEqual([event('exec', 'exec.forwarded', 'error'), event('exec', 'exec.request', 'error')])
  expect(events().every((entry) => !('exec_id' in entry))).toBe(true)
})
