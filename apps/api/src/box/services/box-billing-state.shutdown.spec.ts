/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ExpressAdapter } from '@nestjs/platform-express'
import { ScheduleModule } from '@nestjs/schedule'
import { Test } from '@nestjs/testing'
import axios from 'axios'
import { BoxBillingStateService } from './box-billing-state.service'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

class GatedHttpAdapter extends ExpressAdapter {
  readonly closing = deferred<void>()
  readonly drained = deferred<void>()
  closeStarted = false

  override async close(): Promise<void> {
    this.closeStarted = true
    this.closing.resolve()
    await this.drained.promise
    await super.close()
  }
}

function makeWorker(boxIds = ['box-1']) {
  const settings: Record<string, string> = {
    billingApiUrl: 'https://service.test',
    'usageExport.url': 'https://service.test',
    'usageExport.token': 'test-token',
  }
  const repository = {
    find: jest.fn().mockResolvedValue(boxIds.map((id) => ({ id, organizationId: 'org-1' }))),
  }
  const boxService = { stop: jest.fn().mockResolvedValue(undefined) }
  const lease = { signal: new AbortController().signal, release: jest.fn().mockResolvedValue(undefined) }
  const locks = { acquireLease: jest.fn().mockResolvedValue(lease) }
  const worker = new BoxBillingStateService(
    { get: (key: string) => settings[key] } as never,
    repository as never,
    boxService as never,
    locks as never,
  )
  Object.assign(worker, { logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } })
  return { worker, boxService, lease }
}

async function application(worker: BoxBillingStateService) {
  const beforeShutdown = deferred<void>()
  const module = await Test.createTestingModule({
    imports: [ScheduleModule.forRoot()],
    providers: [
      { provide: BoxBillingStateService, useValue: worker },
      {
        provide: 'shutdown-phase-observer',
        useValue: { beforeApplicationShutdown: () => beforeShutdown.resolve() },
      },
    ],
  }).compile()
  const adapter = new GatedHttpAdapter()
  const app = module.createNestApplication(adapter, { logger: false })
  await app.init()
  return { app, adapter, beforeShutdown }
}

const response = {
  data: [{ organizationId: 'org-1', billingState: 'NEGATIVE', evaluatedAt: '2026-11-06T10:00:00.000Z' }],
}
const get = jest.spyOn(axios, 'get') as jest.Mock

describe('Automatic stop worker application shutdown', () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue(response)
  })
  afterAll(() => get.mockRestore())

  it('cancels pending work before HTTP drain and submits no stop during drain', async () => {
    const harness = makeWorker()
    const { app, adapter } = await application(harness.worker)
    const requested = deferred<AbortSignal>()
    const reply = deferred<typeof response>()
    get.mockImplementation((_url: string, { signal }: { signal: AbortSignal }) => {
      requested.resolve(signal)
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        void reply.promise.then(resolve)
      })
    })

    const run = harness.worker.reconcile()
    const signal = await requested.promise
    const closing = app.close()
    try {
      // Nest has reached the HTTP adapter but cannot finish draining it yet.
      await adapter.closing.promise
      reply.resolve(response)
      await run

      expect(harness.boxService.stop).not.toHaveBeenCalled()
      expect(signal.aborted).toBe(true)
      expect(harness.lease.release).toHaveBeenCalledTimes(1)
      await harness.worker.reconcile()
      expect(get).toHaveBeenCalledTimes(1)
    } finally {
      reply.resolve(response)
      adapter.drained.resolve()
      await Promise.all([closing, run])
    }
  })

  it('waits for an accepted stop before HTTP drain and does not submit the next stop', async () => {
    const harness = makeWorker(['box-1', 'box-2'])
    const { app, adapter, beforeShutdown } = await application(harness.worker)
    const stopStarted = deferred<void>()
    const stopCompleted = deferred<void>()
    harness.boxService.stop.mockImplementation(() => {
      stopStarted.resolve()
      return stopCompleted.promise
    })
    const run = harness.worker.reconcile()
    await stopStarted.promise
    const closing = app.close()
    try {
      await beforeShutdown.promise
      // Let Nest finish its runnable lifecycle steps while the accepted stop waits.
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(adapter.closeStarted).toBe(false)

      stopCompleted.resolve()
      await adapter.closing.promise
      await run
      expect(harness.boxService.stop).toHaveBeenCalledTimes(1)
      expect(harness.lease.release).toHaveBeenCalledTimes(1)
    } finally {
      stopCompleted.resolve()
      adapter.drained.resolve()
      await Promise.all([closing, run])
    }
  })
})
