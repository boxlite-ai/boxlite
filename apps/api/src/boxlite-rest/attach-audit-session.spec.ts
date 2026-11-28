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
    let finish!: () => void
    const pending = new Promise<{ id: string }>((resolve) => {
      finish = () => resolve({ id: 'detach-id' })
    })
    const audit = {
      createLog: jest.fn(async (dto, _timeout: number) =>
        dto.action === 'attach' ? { id: 'audit-id' } : pending,
      ),
      updateLog: jest.fn().mockResolvedValue(undefined),
    }
    for (let cycle = 0; cycle < 25; cycle++) {
      const client = socket()
      const upstream = socket()
      const request = Object.assign(new EventEmitter(), { destroy: jest.fn() })
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
    for (let attempt = 0; audit.createLog.mock.calls.length < 50 && attempt < 100; attempt++) {
      await new Promise(setImmediate)
    }
    expect(audit.createLog).toHaveBeenCalledTimes(50)
    expect(audit.updateLog).toHaveBeenCalledTimes(25)
    for (const call of audit.createLog.mock.calls) expect(call[1]).toBe(5000)
    for (const call of audit.updateLog.mock.calls) expect(call[2]).toBe(5000)
    finish()
    await pending
  })

  it('queues completion and detach behind an initial insert that has not returned its log id', async () => {
    let insert!: (value: { id: string }) => void
    const inserted = new Promise<{ id: string }>((resolve) => (insert = resolve))
    const calls: string[] = []
    const audit = {
      createLog: jest
        .fn()
        .mockImplementationOnce(async (dto) => {
          calls.push(`create:${dto.action}`)
          return inserted
        })
        .mockImplementationOnce(async (dto) => {
          calls.push(`create:${dto.action}`)
          return { id: 'detach-id' }
        }),
      updateLog: jest.fn(async (_id, dto) => {
        calls.push(`update:${dto.statusCode}`)
      }),
    }
    const client = socket()
    const upstream = socket()
    const request = Object.assign(new EventEmitter(), { destroy: jest.fn() })
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
    expect(audit.updateLog).not.toHaveBeenCalled()
    expect(audit.createLog).toHaveBeenCalledTimes(1)
    expect(client.eventNames()).toEqual([])
    expect(upstream.eventNames()).toEqual([])

    insert({ id: 'attach-id' })
    for (let attempt = 0; audit.createLog.mock.calls.length < 2 && attempt < 10; attempt++) {
      await new Promise(setImmediate)
    }

    expect(calls).toEqual(['create:attach', 'update:101', 'create:detach'])
    expect(audit.updateLog).toHaveBeenCalledWith(
      'attach-id',
      { statusCode: 101, metadata: { connectedAt: expect.any(String) } },
      5000,
    )
    expect(audit.createLog.mock.calls[1][0].metadata).toMatchObject({
      connectedAt: expect.any(String),
      disconnectedAt: expect.any(String),
      durationMs: expect.any(Number),
    })
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
    for (let attempt = 0; audit.updateLog.mock.calls.length === 0 && attempt < 10; attempt++) {
      await new Promise(setImmediate)
    }
    expect(audit.updateLog).toHaveBeenCalledWith('audit-id', { statusCode: 0 }, 5000)
  })
})
