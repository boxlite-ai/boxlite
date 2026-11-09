/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { AddressInfo } from 'node:net'
import { installCiWebhookBodyParser, CI_WEBHOOK_PATH } from './ci-webhook-body'
import { CiWebhookController } from './ci-webhook.controller'
import { CiWebhookService } from './ci-webhook.service'

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('CI webhook resource bounds', () => {
  it.each([[], ['signed body'], '{}', { length: 1 }, null])(
    'rejects non-Buffer ingress before persistence: %j',
    async (raw) => {
      const listener = { receive: jest.fn() }
      const service = new CiWebhookService(listener as any, { get: () => undefined } as any)
      await expect(service.receive(raw, '', '', '')).rejects.toThrow('Raw webhook body required')
      expect(listener.receive).not.toHaveBeenCalled()
    },
  )
  it('keeps the HTTP slot while a complete body waits for verification', async () => {
    const entered = barrier(),
      release = barrier()
    const receive = jest.fn(async () => {
      if (receive.mock.calls.length === 32) entered.resolve()
      if (receive.mock.calls.length <= 32) await release.promise
    })
    const module = await Test.createTestingModule({
      controllers: [CiWebhookController],
      providers: [{ provide: CiWebhookService, useValue: { receive } }],
    }).compile()
    const app: INestApplication = module.createNestApplication({ logger: false })
    installCiWebhookBodyParser(app)
    app.setGlobalPrefix('api')
    await app.listen(0, '127.0.0.1')
    const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}${CI_WEBHOOK_PATH}`
    const post = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const pending = Array.from({ length: 32 }, post)
    try {
      await entered.promise
      expect((await post()).status).toBe(503)
      expect(receive).toHaveBeenCalledTimes(32)
    } finally {
      release.resolve()
      await Promise.all(pending)
      await app.close()
    }
  }, 15_000)

  it('bounds concurrent verification before persistence', async () => {
    const secret = randomBytes(32).toString('hex')
    const service = new CiWebhookService(
      {} as any,
      {
        get: (key: string) =>
          key === 'ci.githubClientId' ? 'client' : key === 'ci.githubWebhookSecret' ? secret : undefined,
      } as any,
    )
    const body = Buffer.from('{}')
    const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
    const receive = () => service.receive(body, signature, randomUUID(), 'ping')
    const pending = Array.from({ length: 32 }, receive)
    await expect(receive()).rejects.toThrow('busy')
    await Promise.all(pending)
    await expect(receive()).resolves.toBeUndefined()
  })

  it('holds persistence capacity after HTTP deadlines close pending responses', async () => {
    const entered = barrier(),
      release = barrier(),
      secret = randomBytes(32).toString('hex')
    const transaction = jest.fn(async () => {
      if (transaction.mock.calls.length === 32) entered.resolve()
      await release.promise
    })
    const service = new CiWebhookService(
      { receive: transaction } as any,
      {
        get: (key: string) =>
          key === 'ci.githubClientId' ? 'client' : key === 'ci.githubWebhookSecret' ? secret : undefined,
      } as any,
    )
    const module = await Test.createTestingModule({
      controllers: [CiWebhookController],
      providers: [{ provide: CiWebhookService, useValue: service }],
    }).compile()
    const app = module.createNestApplication({ logger: false })
    installCiWebhookBodyParser(app)
    app.setGlobalPrefix('api')
    await app.listen(0, '127.0.0.1')
    const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}${CI_WEBHOOK_PATH}`
    const body = Buffer.from(
      JSON.stringify({
        action: 'queued',
        installation: { id: 1 },
        repository: { id: 2, owner: { id: 3 } },
        workflow_job: { id: 4, run_id: 5, status: 'queued', labels: ['boxlite-ci-runner'] },
      }),
    )
    const post = () =>
      fetch(url, {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'),
          'x-github-delivery': randomUUID(),
          'x-github-event': 'workflow_job',
        },
      })
    const pending = Array.from({ length: 32 }, post)
    try {
      await entered.promise
      expect((await Promise.all(pending)).map((r) => r.status)).toEqual(Array(32).fill(503))
      expect((await post()).status).toBe(503)
      expect(transaction).toHaveBeenCalledTimes(32)
    } finally {
      release.resolve()
      await Promise.allSettled(transaction.mock.results.map((r) => r.value))
      await Promise.allSettled(pending)
      await app.close()
    }
  }, 20_000)

  it('holds database slots after HTTP timeout until underlying transactions settle', async () => {
    const entered = barrier(),
      release = barrier()
    const transaction = jest.fn(async () => {
      if (transaction.mock.calls.length === 32) entered.resolve()
      await release.promise
    })
    const secret = randomBytes(32).toString('hex')
    const service = new CiWebhookService(
      { receive: transaction } as any,
      {
        get: (key: string) =>
          key === 'ci.githubClientId' ? 'client' : key === 'ci.githubWebhookSecret' ? secret : undefined,
      } as any,
    )
    const body = Buffer.from(
      JSON.stringify({
        action: 'queued',
        installation: { id: 1 },
        repository: { id: 2, owner: { id: 3 } },
        workflow_job: { id: 4, run_id: 5, status: 'queued', labels: ['boxlite-ci-runner'] },
      }),
    )
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
    const receive = () => service.receive(body, signature, randomUUID(), 'workflow_job')
    const pending = Array.from({ length: 32 }, () => receive().catch((error) => error))
    try {
      await entered.promise
      await expect(receive()).rejects.toThrow('busy')
      const timedOut = await Promise.all(pending)
      expect(timedOut.every((error) => error.message.includes('timed out'))).toBe(true)
      await expect(receive()).rejects.toThrow('busy')
      expect(transaction).toHaveBeenCalledTimes(32)
      release.resolve()
      await Promise.all(transaction.mock.results.map((result) => result.value))
      await expect(receive()).resolves.toBeUndefined()
    } finally {
      release.resolve()
      await Promise.all(pending)
    }
  }, 15_000)
})
