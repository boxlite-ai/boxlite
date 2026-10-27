import { Logger } from '@nestjs/common'
import { BoxService } from './box.service'

describe('Activity business events for browser presence', () => {
  afterEach(() => jest.restoreAllMocks())
  it.each(['accepted', 'duplicate', 'redis failure'])('derives organization and fails closed: %s', async (result) => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const redis = { set: jest.fn() }
    if (result === 'redis failure') redis.set.mockRejectedValue(new Error('private-redis-error'))
    else redis.set.mockResolvedValue(result === 'accepted' ? 'OK' : null)
    const activity = { updateLastActivityAt: jest.fn().mockResolvedValue(undefined) }
    const service: BoxService = Object.assign(Object.create(BoxService.prototype), {
      redis,
      boxActivityService: activity,
      logger: new Logger('BoxService'),
      findOne: jest.fn().mockResolvedValue({ id: 'box-1', organizationId: 'stored-org' }),
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
  })
})
