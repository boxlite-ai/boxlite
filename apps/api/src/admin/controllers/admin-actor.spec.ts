import { AdminBoxController } from './box.controller'
import { UserController } from '../../user/user.controller'

describe('Admin request actor propagation', () => {
  const request = {
    user: { userId: 'admin-1', role: 'admin', email: 'admin@example.test', apiKey: {} },
    get: () => undefined,
  }

  it('attributes box recovery to the authenticated administrator', async () => {
    const organization = { id: 'org-1' }
    const box = { id: 'box-1' }
    const service = { recover: jest.fn().mockResolvedValue(box), toBoxDto: jest.fn((value) => value) }
    const controller = new AdminBoxController(
      service as never,
      { findByBoxId: jest.fn().mockResolvedValue(organization) } as never,
    )
    await controller.recoverBox(box.id, request as never)
    expect(service.recover).toHaveBeenCalledWith(
      box.id,
      organization,
      expect.objectContaining({
        actorKind: 'admin',
        actor: expect.objectContaining({ userId: 'admin-1', authMethod: 'api_key' }),
      }),
    )
  })

  it('attributes admin-created users to the authenticated administrator', async () => {
    const service = { create: jest.fn().mockResolvedValue({ id: 'new-user' }) }
    const controller = new UserController(service as never, {} as never)
    const input = { name: 'New user' }
    await controller.create(input as never, request as never)
    expect(service.create).toHaveBeenCalledWith(
      input,
      expect.objectContaining({
        actorKind: 'admin',
        actor: expect.objectContaining({ userId: 'admin-1', authMethod: 'api_key' }),
      }),
    )
  })
})
