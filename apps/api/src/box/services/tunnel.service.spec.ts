/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException, NotFoundException } from '@nestjs/common'
import { TunnelService } from './tunnel.service'

function makeService() {
  const builder = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getExists: jest.fn().mockResolvedValue(true),
  }
  const repository = {
    query: jest.fn().mockResolvedValue([{ id: 'tunnel-1' }]),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn().mockReturnValue(builder),
  }
  return { service: new TunnelService(repository as never), repository, builder }
}

describe('TunnelService', () => {
  it('declares one public port through an atomic conflict-aware write', async () => {
    const { service, repository } = makeService()

    await service.declarePublic('AbCdEf123456', 3000)

    expect(repository.query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT ("box_id", "port") DO UPDATE'), [
      'AbCdEf123456',
      3000,
    ])
  })

  it('does not replace a private tunnel or accept an invalid port', async () => {
    const { service, repository } = makeService()
    repository.query.mockResolvedValue([])

    await expect(service.declarePublic('AbCdEf123456', 3000)).rejects.toBeInstanceOf(ConflictException)
    await expect(service.declarePublic('AbCdEf123456', 0)).rejects.toThrow('Invalid tunnel port')
    expect(repository.query).toHaveBeenCalledTimes(1)
  })

  it('requires an active public tunnel and a currently public box', async () => {
    const { service, builder } = makeService()

    await expect(service.isPublicAccessAllowed('AbCdEf123456', 3000)).resolves.toBe(true)

    expect(builder.where).toHaveBeenCalledWith('tunnel.box_id = :boxId', { boxId: 'AbCdEf123456' })
    expect(builder.andWhere).toHaveBeenCalledWith('tunnel.port = :port', { port: 3000 })
    expect(builder.andWhere).toHaveBeenCalledWith('tunnel.access_mode = :mode', { mode: 'public' })
    expect(builder.andWhere).toHaveBeenCalledWith('tunnel.revoked_at IS NULL')
    expect(builder.andWhere).toHaveBeenCalledWith('box.public = true')
  })

  it('reports a missing tunnel on revoke', async () => {
    const { service, repository } = makeService()
    repository.update.mockResolvedValue({ affected: 0 })

    await expect(service.revoke('AbCdEf123456', 3000)).rejects.toBeInstanceOf(NotFoundException)
  })
})
