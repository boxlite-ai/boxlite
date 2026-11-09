/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { Listener, VerifiedWebhook } from '@boxlite-ai/ci-listener'
import { CiListenerService } from './ci-listener.service'

it('rejects ingress after the hosted scheduler unexpectedly stops', async () => {
  const failure = new Error('scheduler stopped')
  const run = jest.spyOn(Listener.prototype, 'run').mockRejectedValue(failure)
  const receive = jest.spyOn(Listener.prototype, 'receive').mockResolvedValue('stored')
  const host = { report: jest.fn(), close: jest.fn() }
  const service = new CiListenerService(
    { app: 'app', initialize: jest.fn(), state: {} } as any,
    host as any,
    { get: (key: string) => ({ 'ci.workerCPUs': 1, 'ci.workerMemoryGB': 1, 'ci.workerImage': 'runner' })[key] } as any,
    { configured: () => [{ settings: jest.fn() }] } as any,
    { initialize: jest.fn() } as any,
  )
  try {
    await service.onModuleInit()
    await expect(service.receive({} as VerifiedWebhook)).rejects.toThrow('Hosted CI Listener has stopped')
    expect(receive).not.toHaveBeenCalled()
    await expect(service.onModuleDestroy()).rejects.toBe(failure)
    expect(host.close).toHaveBeenCalledTimes(1)
  } finally {
    run.mockRestore()
    receive.mockRestore()
  }
})
