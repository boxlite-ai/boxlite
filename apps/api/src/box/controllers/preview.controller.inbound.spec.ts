import { NotFoundException } from '@nestjs/common'
import { PreviewController } from './preview.controller'
import { NetworkMode } from '../enums/network-mode.enum'

// The proxy asks this route on every preview and tunnel request, so the
// answers come from a short Redis cache that must also remember a missing box.
function makeController() {
  const store = new Map<string, string>()
  const redis = {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    setex: jest.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value)
      return 'OK'
    }),
  }
  const boxService = { getInboundMode: jest.fn() }
  const controller = new PreviewController(
    redis as never,
    boxService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  )
  return { controller, redis, boxService, store }
}

describe('PreviewController inbound mode', () => {
  it.each([NetworkMode.ENABLED, NetworkMode.DISABLED])('reports inbound %s and caches it', async (mode) => {
    const { controller, boxService, redis } = makeController()
    boxService.getInboundMode.mockResolvedValue(mode)

    expect(await controller.getBoxInboundMode('AbCdEf123456')).toBe(mode)
    expect(await controller.getBoxInboundMode('AbCdEf123456')).toBe(mode)

    expect(boxService.getInboundMode).toHaveBeenCalledTimes(1)
    expect(redis.setex).toHaveBeenCalledWith('preview:inbound:AbCdEf123456', 3, mode)
  })

  it('answers 404 for a missing box and remembers the miss', async () => {
    const { controller, boxService } = makeController()
    boxService.getInboundMode.mockRejectedValue(new NotFoundException('Box with ID nope not found'))

    await expect(controller.getBoxInboundMode('nope')).rejects.toBeInstanceOf(NotFoundException)
    await expect(controller.getBoxInboundMode('nope')).rejects.toBeInstanceOf(NotFoundException)

    expect(boxService.getInboundMode).toHaveBeenCalledTimes(1)
  })
})
