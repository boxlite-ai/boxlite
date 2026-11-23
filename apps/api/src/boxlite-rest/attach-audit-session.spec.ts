import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import type { ClientRequest } from 'node:http'
import { AttachAuditSession } from './attach-audit-session'
import { AuditService } from '../audit/services/audit.service'

describe('attach audit resource ownership', () => {
  const identity = { actorId: 'actor', actorEmail: '', organizationId: 'org', targetId: 'box' }

  function socket() {
    return Object.assign(new EventEmitter(), { destroy: jest.fn(), destroyed: false, readableEnded: false })
  }

  it('drops socket and request references while disconnect persistence is still pending', async () => {
    const audit = {
      createLog: jest.fn().mockResolvedValue({ id: 'audit-id' }),
      updateLog: jest.fn().mockResolvedValue(undefined),
    }
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    for (let cycle = 0; cycle < 25; cycle++) {
      const client = socket()
      const upstream = socket()
      const request = Object.assign(new EventEmitter(), { destroy: jest.fn() })
      audit.createLog.mockResolvedValueOnce({ id: 'audit-id' }).mockImplementationOnce(() => pending)
      const session = await AttachAuditSession.start(
        audit as unknown as AuditService,
        client as unknown as Socket,
        identity,
        'exec',
      )
      if (!session) throw new Error('Expected attach session')
      session.bind(request as unknown as ClientRequest)
      request.emit('upgrade', {}, upstream)
      client.emit('close')
      upstream.emit('close')
      expect(client.eventNames()).toEqual([])
      expect(upstream.eventNames()).toEqual([])
      expect(request.eventNames()).toEqual([])
      expect(session).toMatchObject({ client: undefined, upstream: undefined, request: undefined })
    }
    expect(audit.createLog).toHaveBeenCalledTimes(50)
    expect(audit.updateLog).toHaveBeenCalledTimes(25)
    for (const call of audit.createLog.mock.calls) expect(call[1]).toBe(5000)
    for (const call of audit.updateLog.mock.calls) expect(call[2]).toBe(5000)
    finish()
    await pending
  })

  it('still destroys a pending upstream request when closing before acceptance', async () => {
    const audit = { createLog: async () => ({ id: 'audit-id' }), updateLog: jest.fn().mockResolvedValue(undefined) }
    const client = socket()
    const request = Object.assign(new EventEmitter(), { destroy: jest.fn() })
    const session = await AttachAuditSession.start(
      audit as unknown as AuditService,
      client as unknown as Socket,
      identity,
      'exec',
    )
    if (!session) throw new Error('Expected attach session')
    session.bind(request as unknown as ClientRequest)
    client.emit('close')
    expect(request.destroy).toHaveBeenCalledTimes(1)
    expect(request.eventNames()).toEqual([])
    expect(audit.updateLog).toHaveBeenCalledWith('audit-id', { statusCode: 0 }, 5000)
  })
})
