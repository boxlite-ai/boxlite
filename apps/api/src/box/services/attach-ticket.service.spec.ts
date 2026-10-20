/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { AttachTicketService, ATTACH_TICKET_TTL_SECONDS } from './attach-ticket.service'

/** The two Redis calls the service makes, over a map, recording each SET's TTL. */
function fakeRedis() {
  const store = new Map<string, string>()
  const ttls = new Map<string, number>()
  return {
    store,
    ttls,
    set: jest.fn(async (key: string, value: string, _mode: 'EX', ttl: number) => {
      store.set(key, value)
      ttls.set(key, ttl)
      return 'OK'
    }),
    getdel: jest.fn(async (key: string) => {
      const value = store.get(key) ?? null
      store.delete(key)
      return value
    }),
  }
}

describe('AttachTicketService', () => {
  const grant = { userId: 'user-1', organizationId: 'org-1', boxId: 'box-uuid', execId: 'exec-1' }

  it('hands back the grant once, then never again', async () => {
    const service = new AttachTicketService(fakeRedis() as never)
    const ticket = await service.issue(grant)

    await expect(service.consume(ticket)).resolves.toEqual(grant)
    await expect(service.consume(ticket)).resolves.toBeNull()
  })

  it('rejects a ticket it never issued', async () => {
    const service = new AttachTicketService(fakeRedis() as never)
    await service.issue(grant)

    await expect(service.consume('not-a-ticket')).resolves.toBeNull()
  })

  // A ticket can end up in an access log; Redis must not be another copy.
  it('stores only a hash of the ticket, for 30 seconds', async () => {
    const redis = fakeRedis()
    const ticket = await new AttachTicketService(redis as never).issue(grant)

    const [key] = [...redis.store.keys()]
    expect(key).not.toContain(ticket)
    expect(redis.store.get(key)).not.toContain(ticket)
    expect(redis.ttls.get(key)).toBe(ATTACH_TICKET_TTL_SECONDS)
    expect(ATTACH_TICKET_TTL_SECONDS).toBe(30)
  })
})
