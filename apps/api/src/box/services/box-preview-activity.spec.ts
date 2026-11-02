import { Logger } from '@nestjs/common'
import { BoxService } from './box.service'

describe('Activity business events for browser presence', () => {
  afterEach(() => jest.restoreAllMocks())
  it('keeps ordinary heartbeats free of preview events and cooldown writes', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    const activity = { updateLastActivityAt: jest.fn().mockResolvedValue(undefined) }
    const redis = { set: jest.fn() }
    const service: BoxService = Object.assign(Object.create(BoxService.prototype), {
      redis,
      boxActivityService: activity,
    })
    const at = new Date('2026-11-02T00:00:00Z')

    await service.updateLastActivityAt('box-1', at)

    expect(activity.updateLastActivityAt).toHaveBeenCalledWith('box-1', at)
    expect(redis.set).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })
  it.each(['accepted', 'duplicate', 'redis failure', 'lookup failure'])(
    'derives organization and fails closed: %s',
    async (result) => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      const redis = { set: jest.fn() }
      if (result === 'redis failure') redis.set.mockRejectedValue(new Error('private-redis-error'))
      else redis.set.mockResolvedValue(result === 'accepted' || result === 'lookup failure' ? 'OK' : null)
      const findOne =
        result === 'lookup failure'
          ? jest.fn().mockRejectedValue(new Error('private-database-error'))
          : jest.fn().mockResolvedValue({ id: 'box-1', organizationId: 'stored-org' })
      const activity = { updateLastActivityAt: jest.fn().mockResolvedValue(undefined) }
      const service: BoxService = Object.assign(Object.create(BoxService.prototype), {
        redis,
        boxActivityService: activity,
        logger: new Logger('BoxService'),
        findOne,
      })
      await service.updateLastActivityAt('box-1', new Date(), true)
      expect(activity.updateLastActivityAt).toHaveBeenCalledTimes(1)
      expect(redis.set).toHaveBeenCalledWith('box:preview-open:box-1', '1', 'EX', 60, 'NX')
      if (result === 'accepted') {
        expect(log).toHaveBeenCalledWith(
          'box.open success',
          expect.objectContaining({ 'organization.id': 'stored-org', 'correlation.id': 'box-1' }),
        )
        expect(log.mock.calls[0][1]).not.toHaveProperty('user.id')
        expect(log.mock.calls[0][1]).not.toHaveProperty('actor.kind')
      } else expect(log).not.toHaveBeenCalled()
      if (result.endsWith('failure')) {
        expect(warn).toHaveBeenCalledWith('Preview activity observation could not be recorded', {
          boxId: 'box-1',
          operation: result === 'redis failure' ? 'deduplicate' : 'load_box',
          errorType: 'internal',
        })
        expect(JSON.stringify(warn.mock.calls)).not.toContain('private-')
      }
    },
  )
})
