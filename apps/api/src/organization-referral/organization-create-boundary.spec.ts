import { ValidationPipe } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { OrganizationController } from '../organization/controllers/organization.controller'
import { CreateOrganizationDto } from '../organization/dto/create-organization.dto'
import { Organization } from '../organization/entities/organization.entity'

describe('Ordinary organization creation boundary', () => {
  it('does not forward caller-supplied invitation attribution to the internal creation service', async () => {
    const body = await new ValidationPipe({ transform: true }).transform(
      {
        name: 'Another organization',
        defaultRegionId: 'region-1',
        referralCode: 'ABCDEFGH23',
        referredCode: 'ABCD2345EF',
        inviterOrganizationId: randomUUID(),
      },
      { type: 'body', metatype: CreateOrganizationDto },
    )
    const create = jest.fn().mockResolvedValue(Object.assign(new Organization(), { id: randomUUID() }))
    const controller = new OrganizationController(
      { create } as never,
      {} as never,
      {} as never,
      { findOne: async () => ({ emailVerified: true }) } as never,
      { get: () => false } as never,
      {} as never,
    )

    await controller.create({ userId: 'creator' } as never, body)

    expect(create).toHaveBeenCalledWith(
      { name: 'Another organization', defaultRegionId: 'region-1' },
      'creator',
      false,
      true,
    )
  })
})
