/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { BoxService } from './box.service'
import * as networkPolicy from '../runner-adapter/network-policy'

function fixture(runner: unknown = { id: 'runner1' }) {
  const service = Object.create(BoxService.prototype) as BoxService
  const locked = { id: 'box1', runnerId: 'runner1' }
  const boxRepository = {
    replaceOutbound: jest.fn(async (_id, _org, policy, apply) => {
      await apply(locked, policy)
      return locked
    }),
  }
  const runnerService = { findOne: jest.fn().mockResolvedValue(runner) }
  Object.assign(service, { boxRepository, runnerService })
  jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue({ id: 'box1' } as any)
  return { service, boxRepository, runnerService }
}

describe('BoxService outbound policy replacement', () => {
  afterEach(() => jest.restoreAllMocks())

  it('resolves the name and applies the policy through the box runner', async () => {
    const send = jest.spyOn(networkPolicy, 'setRunnerOutbound').mockResolvedValue(undefined)
    const { service, boxRepository, runnerService } = fixture()
    const policy = { mode: 'enabled' as const, allow_net: ['*.example.com'] }

    await service.setOutboundNetwork('mybox', policy, 'org1')

    expect(service.findOneByIdOrName).toHaveBeenCalledWith('mybox', 'org1')
    expect(boxRepository.replaceOutbound).toHaveBeenCalledWith('box1', 'org1', policy, expect.any(Function))
    expect(runnerService.findOne).toHaveBeenCalledWith('runner1')
    expect(send).toHaveBeenCalledWith({ id: 'runner1' }, 'box1', policy)
  })

  it('sends and stores the trimmed outbound allowlist that create would store', async () => {
    const send = jest.spyOn(networkPolicy, 'setRunnerOutbound').mockResolvedValue(undefined)
    const { service, boxRepository } = fixture()

    await service.setOutboundNetwork('box1', { mode: 'enabled', allow_net: [' example.com '] }, 'org1')

    const trimmed = { mode: 'enabled', allow_net: ['example.com'] }
    expect(boxRepository.replaceOutbound).toHaveBeenCalledWith('box1', 'org1', trimmed, expect.any(Function))
    expect(send).toHaveBeenCalledWith({ id: 'runner1' }, 'box1', trimmed)
  })

  it.each([
    ['a disabled policy with rules', { mode: 'disabled' as const, allow_net: ['example.com'] }, 'disabled outbound'],
    ['an invalid rule', { mode: 'enabled' as const, allow_net: ['10.0.0.0/33'] }, 'Invalid network allow list'],
  ])('rejects %s before locking the box', async (_name, policy, message) => {
    const { service, boxRepository } = fixture()
    await expect(service.setOutboundNetwork('box1', policy, 'org1')).rejects.toThrow(message)
    expect(boxRepository.replaceOutbound).not.toHaveBeenCalled()
  })

  it('refuses a box whose runner is gone', async () => {
    const send = jest.spyOn(networkPolicy, 'setRunnerOutbound')
    const { service } = fixture(null)
    await expect(service.setOutboundNetwork('box1', { mode: 'enabled', allow_net: [] }, 'org1')).rejects.toThrow(
      'runner is unavailable',
    )
    expect(send).not.toHaveBeenCalled()
  })
})
