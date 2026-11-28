/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxService } from './box.service'
import { BoxState } from '../enums/box-state.enum'
import { VOLUME_MOUNT_OPTIONS_CAPABILITY } from './runner.service'
import { Context } from '../../common/context/context'
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common'

describe('BoxService.recover volume mount options', () => {
  it('rejects recovery before contacting a runner without the capability', async () => {
    const runner = { id: 'runner-1', apiVersion: '0', capabilities: [] }
    const runnerService = { findOneOrFail: jest.fn().mockResolvedValue(runner) } as any
    const runnerAdapterFactory = {
      create: jest.fn().mockResolvedValue({
        recoverBox: jest.fn(),
        runnerInfo: jest.fn().mockResolvedValue({ capabilities: [] }),
      }),
    } as any
    const boxRepository = {
      findOneByIdOrName: jest.fn().mockResolvedValue({
        id: 'box-1',
        state: BoxState.ERROR,
        pending: false,
        runnerId: runner.id,
        volumes: [{ volumeId: 'volume-1', mountPath: '/data', readOnly: true }],
      }),
      updateWhere: jest.fn(),
    } as any
    const noop = {} as any
    const service = new BoxService(
      boxRepository,
      noop,
      runnerService,
      noop,
      noop,
      { getOrThrow: () => 1 } as any,
      noop,
      { emit: jest.fn() } as any,
      { assertOrganizationIsNotSuspended: jest.fn() } as any,
      runnerAdapterFactory,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      { reasonFor: jest.fn() } as any,
      noop,
      noop,
      noop as any,
    )

    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(boxRepository.findOneByIdOrName())

    await expect(service.recover('box-1', { id: 'org-1' } as any, Context.user())).rejects.toThrow(
      'VOLUME_MOUNT_OPTIONS_UNSUPPORTED',
    )
    expect(runnerAdapterFactory.create).not.toHaveBeenCalled()
    expect(boxRepository.updateWhere).not.toHaveBeenCalled()
  })

  it('recovers when the runner advertises the capability', async () => {
    const runner = { id: 'runner-1', apiVersion: '0', capabilities: [VOLUME_MOUNT_OPTIONS_CAPABILITY] }
    const runnerService = { findOneOrFail: jest.fn().mockResolvedValue(runner) } as any
    const recoverBox = jest.fn().mockResolvedValue(undefined)
    const runnerAdapterFactory = {
      create: jest.fn().mockResolvedValue({
        recoverBox,
        runnerInfo: jest.fn().mockResolvedValue({ capabilities: [VOLUME_MOUNT_OPTIONS_CAPABILITY] }),
      }),
    } as any
    const boxRepository = {
      findOneByIdOrName: jest.fn().mockResolvedValue({
        id: 'box-1',
        state: BoxState.ERROR,
        pending: false,
        runnerId: runner.id,
        volumes: [{ volumeId: 'volume-1', mountPath: '/data', readOnly: true }],
      }),
      updateWhere: jest.fn().mockResolvedValue({ id: 'box-1' }),
    } as any
    const noop = {} as any
    const service = new BoxService(
      boxRepository,
      noop,
      runnerService,
      noop,
      noop,
      { getOrThrow: () => 1 } as any,
      noop,
      { emit: jest.fn() } as any,
      { assertOrganizationIsNotSuspended: jest.fn() } as any,
      runnerAdapterFactory,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      { reasonFor: jest.fn() } as any,
      noop,
      noop,
      noop as any,
    )

    const box = boxRepository.findOneByIdOrName()
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(box)
    jest.spyOn(service, 'start').mockResolvedValue(box)

    await expect(service.recover('box-1', { id: 'org-1' } as any, Context.user())).resolves.toBeDefined()
    expect(runnerAdapterFactory.create).toHaveBeenCalledWith(runner)
    expect(recoverBox).toHaveBeenCalledWith(expect.objectContaining({ id: 'box-1' }))
    expect(boxRepository.updateWhere).toHaveBeenCalledWith(
      'box-1',
      expect.objectContaining({
        updateData: expect.objectContaining({ state: BoxState.STOPPED }),
      }),
    )
  })

  it('rejects recovery when a stale row advertises capability but the live report does not', async () => {
    const runner = { id: 'runner-1', apiVersion: '0', capabilities: [VOLUME_MOUNT_OPTIONS_CAPABILITY] }
    const runnerService = { findOneOrFail: jest.fn().mockResolvedValue(runner) } as any
    const recoverBox = jest.fn()
    const runnerAdapterFactory = {
      create: jest.fn().mockResolvedValue({
        recoverBox,
        runnerInfo: jest.fn().mockResolvedValue({ capabilities: [] }),
      }),
    } as any
    const boxRepository = {
      findOneByIdOrName: jest.fn().mockResolvedValue({
        id: 'box-1',
        state: BoxState.ERROR,
        pending: false,
        runnerId: runner.id,
        volumes: [{ volumeId: 'volume-1', mountPath: '/data', readOnly: true }],
      }),
      updateWhere: jest.fn(),
    } as any
    const noop = {} as any
    const service = new BoxService(
      boxRepository,
      noop,
      runnerService,
      noop,
      noop,
      { getOrThrow: () => 1 } as any,
      noop,
      { emit: jest.fn() } as any,
      { assertOrganizationIsNotSuspended: jest.fn() } as any,
      runnerAdapterFactory,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      { reasonFor: jest.fn() } as any,
      noop,
      noop,
      noop as any,
    )
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(boxRepository.findOneByIdOrName())

    await expect(service.recover('box-1', { id: 'org-1' } as any, Context.user())).rejects.toThrow(ForbiddenException)
    expect(recoverBox).not.toHaveBeenCalled()
    expect(boxRepository.updateWhere).not.toHaveBeenCalled()
  })

  it('keeps recovery retryable when the live capability probe is unavailable', async () => {
    const runner = { id: 'runner-1', apiVersion: '0', capabilities: [VOLUME_MOUNT_OPTIONS_CAPABILITY] }
    const runnerService = { findOneOrFail: jest.fn().mockResolvedValue(runner) } as any
    const recoverBox = jest.fn()
    const runnerAdapterFactory = {
      create: jest.fn().mockResolvedValue({
        recoverBox,
        runnerInfo: jest.fn().mockRejectedValue(new Error('network unavailable')),
      }),
    } as any
    const boxRepository = {
      findOneByIdOrName: jest.fn().mockResolvedValue({
        id: 'box-1',
        state: BoxState.ERROR,
        pending: false,
        runnerId: runner.id,
        volumes: [{ volumeId: 'volume-1', mountPath: '/data', readOnly: true }],
      }),
      updateWhere: jest.fn(),
    } as any
    const noop = {} as any
    const service = new BoxService(
      boxRepository,
      noop,
      runnerService,
      noop,
      noop,
      { getOrThrow: () => 1 } as any,
      noop,
      { emit: jest.fn() } as any,
      { assertOrganizationIsNotSuspended: jest.fn() } as any,
      runnerAdapterFactory,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      noop,
      { reasonFor: jest.fn() } as any,
      noop,
      noop,
      noop as any,
    )
    jest.spyOn(service, 'findOneByIdOrName').mockResolvedValue(boxRepository.findOneByIdOrName())

    await expect(service.recover('box-1', { id: 'org-1' } as any, Context.user())).rejects.toThrow(
      ServiceUnavailableException,
    )
    expect(recoverBox).not.toHaveBeenCalled()
    expect(boxRepository.updateWhere).not.toHaveBeenCalled()
  })
})
