import { Logger } from '@nestjs/common'
import { BoxService } from './box.service'
import { BoxActivityService } from './box-activity.service'
import { RedisLockProvider } from '../common/redis-lock.provider'

function deferred() {
  let resolve!: (value: unknown) => void
  let reject!: (error: Error) => void
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('Preview activity deadline', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  function harness(stage = '') {
    const blocked = deferred()
    const box = { id: 'box-1', organizationId: 'stored-org' }
    const redis = {
      set: jest.fn(async (key: string) => {
        if (
          (stage === 'activity_lock' && key.startsWith('box:update-last-activity:')) ||
          (stage === 'deduplicate' && key.startsWith('box:preview-open:'))
        )
          return blocked.promise
        return 'OK'
      }),
      zadd: jest.fn(async () => (stage === 'activity_buffer' ? blocked.promise : 1)),
    }
    const activity = new BoxActivityService(redis as never, {} as never, new RedisLockProvider(redis as never), {
      getOrThrow: () => 30,
    } as never)
    const findOne = jest.fn(async () => (stage === 'load_box' ? blocked.promise : box))
    const service: BoxService = Object.assign(Object.create(BoxService.prototype), {
      redis,
      boxActivityService: activity,
      findOne,
      logger: new Logger('BoxService'),
    })
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    return { service, blocked, redis, findOne, box, log, warn }
  }

  it.each(
    ['activity_lock', 'activity_buffer', 'deduplicate', 'load_box'].flatMap((stage) =>
      ['resolve', 'reject'].map((late) => [stage, late]),
    ),
  )('bounds stalled %s and ignores late %s', async (stage, late) => {
    const { service, blocked, redis, findOne, box, log, warn } = harness(stage)
    let settled = false
    const response = service.updateLastActivityAt(box.id, new Date(), true).then(() => {
      settled = true
    })
    await jest.advanceTimersByTimeAsync(1499)
    expect(settled).toBe(false)
    await jest.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    await response
    expect(warn).toHaveBeenCalledWith('Preview activity observation could not be recorded', {
      boxId: box.id,
      operation: stage.startsWith('activity_') ? 'update_activity' : stage,
      errorType: 'timeout',
    })
    if (late === 'reject') blocked.reject(new Error('private-redis-error'))
    else blocked.resolve(stage === 'load_box' ? box : 'OK')
    await jest.advanceTimersByTimeAsync(0)
    expect(log).not.toHaveBeenCalled()
    if (stage === 'activity_lock') expect(redis.zadd).not.toHaveBeenCalled()
    if (stage.startsWith('activity_')) expect(redis.set.mock.calls).toHaveLength(1)
    if (stage !== 'load_box') expect(findOne).not.toHaveBeenCalled()
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-')
    expect(jest.getTimerCount()).toBe(0)
  })

  it('preserves timely lock, buffer, cooldown and event ordering without leaving a timer', async () => {
    const { service, redis, findOne, log } = harness()
    const at = new Date()
    await service.updateLastActivityAt('box-1', at, true)
    expect(redis.set.mock.calls).toEqual([
      ['box:update-last-activity:box-1', '1', 'EX', 30, 'NX'],
      ['box:preview-open:box-1', '1', 'EX', 60, 'NX'],
    ])
    expect(redis.zadd).toHaveBeenCalledWith('box:activity', at.getTime(), 'box-1')
    expect(redis.zadd.mock.invocationCallOrder[0]).toBeLessThan(redis.set.mock.invocationCallOrder[1])
    expect(findOne).toHaveBeenCalledWith('box-1')
    expect(log).toHaveBeenCalledWith('box.open success', expect.objectContaining({ 'organization.id': 'stored-org' }))
    expect(jest.getTimerCount()).toBe(0)
  })

  it('preserves the ordinary heartbeat wait and error semantics', async () => {
    const { service, blocked, redis, log } = harness('activity_lock')
    let settled = false
    const response = service.updateLastActivityAt('box-1', new Date()).then(() => {
      settled = true
    })
    await jest.advanceTimersByTimeAsync(2000)
    expect(settled).toBe(false)
    blocked.resolve('OK')
    await response
    expect(redis.zadd).toHaveBeenCalledTimes(1)
    expect(log).not.toHaveBeenCalled()
  })

  it.each([false, true])('preserves an activity write failure for preview=%s', async (preview) => {
    const { service, blocked, warn } = harness('activity_lock')
    const error = new Error('private-activity-error')
    const result = expect(service.updateLastActivityAt('box-1', new Date(), preview)).rejects.toThrow(error)
    blocked.reject(error)
    await result
    expect(warn).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  })

  it('shares one deadline across lock and buffer waits', async () => {
    const { service, redis, blocked } = harness('activity_buffer')
    redis.set.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      return 'OK'
    })
    let settled = false
    const response = service.updateLastActivityAt('box-1', new Date(), true).then(() => {
      settled = true
    })
    await jest.advanceTimersByTimeAsync(1499)
    expect(redis.zadd).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    await jest.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    await response
    blocked.resolve(1)
    await jest.advanceTimersByTimeAsync(0)
    expect(redis.set).toHaveBeenCalledTimes(1)
  })
})
