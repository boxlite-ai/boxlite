/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Reflector } from '@nestjs/core'
import { GUARDS_METADATA } from '@nestjs/common/constants'
import { BoxController } from './box.controller'
import { BoxAccessGuard } from '../guards/box-access.guard'
import { AttachTicketService } from '../services/attach-ticket.service'
import { RequiredOrganizationResourcePermissions } from '../../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../../organization/enums/organization-resource-permission.enum'

/** The two Redis calls `AttachTicketService` makes, over a map. */
function fakeRedis() {
  const store = new Map<string, string>()
  return {
    set: async (key: string, value: string) => (store.set(key, value), 'OK'),
    getdel: async (key: string) => {
      const value = store.get(key) ?? null
      store.delete(key)
      return value
    },
  }
}

function makeController() {
  const boxService = { findOneByIdOrName: jest.fn().mockResolvedValue({ id: 'box-uuid' }) }
  // The constructor subscribes to box events on a duplicate connection.
  const redis = { duplicate: () => ({ subscribe: jest.fn(), on: jest.fn() }) }
  const attachTickets = new AttachTicketService(fakeRedis() as never)
  const controller = new BoxController({} as never, boxService as never, redis as never, attachTickets)
  return { controller, boxService, attachTickets }
}

describe('BoxController.createAttachTicket', () => {
  // A ticket unlocks an interactive shell, so it takes what exec takes.
  it('requires write:boxes on a box the caller can reach', () => {
    const handler = BoxController.prototype.createAttachTicket
    expect(new Reflector().get(RequiredOrganizationResourcePermissions, handler)).toEqual([
      OrganizationResourcePermission.WRITE_BOXES,
    ])
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(BoxAccessGuard)
  })

  // The attach upgrade compares the ticket's box with the box it resolves,
  // so the ticket names the box by id whatever the caller called it.
  it('issues a ticket bound to the caller, the box id and the execution', async () => {
    const { controller, boxService, attachTickets } = makeController()
    const authContext = { userId: 'user-1', organizationId: 'org-1' } as never

    const issued = await controller.createAttachTicket(authContext, 'my-box', { executionId: 'exec-1' })

    expect(boxService.findOneByIdOrName).toHaveBeenCalledWith('my-box', 'org-1')
    expect(issued.expiresIn).toBe(30)
    await expect(attachTickets.consume(issued.ticket)).resolves.toEqual({
      userId: 'user-1',
      organizationId: 'org-1',
      boxId: 'box-uuid',
      execId: 'exec-1',
    })
  })

  // So the attach is judged by the key's permissions, and refused once the
  // key is revoked or expires, rather than by the user's interactive role.
  it('records the API key that bought the ticket', async () => {
    const { controller, attachTickets } = makeController()
    const authContext = { userId: 'user-1', organizationId: 'org-1', apiKey: { keyHash: 'key-hash-1' } } as never

    const issued = await controller.createAttachTicket(authContext, 'my-box', { executionId: 'exec-1' })

    await expect(attachTickets.consume(issued.ticket)).resolves.toMatchObject({ apiKeyHash: 'key-hash-1' })
  })
})
