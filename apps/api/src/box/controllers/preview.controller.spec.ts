import { NotFoundException } from '@nestjs/common'
import { PreviewController } from './preview.controller'

describe('PreviewController public tunnel check', () => {
  const access = jest.fn()
  const controller = new PreviewController(null as never, null as never, null as never, {
    isPublicAccessAllowed: access,
  } as never)

  beforeEach(() => access.mockReset())

  it('keeps the proxy-only endpoint out of generated API clients', () => {
    expect(Reflect.getMetadata('swagger/apiExcludeEndpoint', controller.isPublicTunnelActive)).toEqual({ disable: true })
  })

  it('accepts only an active public tunnel', async () => {
    access.mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    await expect(controller.isPublicTunnelActive('box-1', 3000)).rejects.toBeInstanceOf(NotFoundException)
    await expect(controller.isPublicTunnelActive('box-1', 3000)).resolves.toBe(true)
    expect(access).toHaveBeenCalledWith('box-1', 3000)
  })
})
