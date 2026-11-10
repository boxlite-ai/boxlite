/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { Box } from '../entities/box.entity'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { JobType } from '../enums/job-type.enum'
import { RunnerState } from '../enums/runner-state.enum'
import { LockCode } from '../common/redis-lock.provider'
import { RunnerAdapterV2 } from '../runner-adapter/runnerAdapter.v2'
import { RunnerAdapterV0 } from '../runner-adapter/runnerAdapter.v0'
import { BoxStartAction } from './box-actions/box-start.action'
import { BoxManager } from './box.manager'

describe('BoxManager nested start preflight recovery', () => {
  async function fixture(v0?: { adapter: RunnerAdapterV0; apiUrl: string }) {
    const box = Object.assign(new Box('region', 'saved'), {
      id: 'box',
      organizationId: 'org',
      runnerId: 'runner',
      state: BoxState.STOPPED,
      desiredState: BoxDesiredState.STARTED,
      nestedVirtualization: false,
      pending: true,
    })
    const report = {
      id: 'runner',
      apiVersion: v0 ? '0' : '2',
      apiKey: 'synthetic',
      apiUrl: v0?.apiUrl,
      state: RunnerState.READY,
      lastChecked: new Date(),
      nestedVirtualizationEnabled: true,
      nestedVirtualizationStartEnabled: true,
    }
    const persist = jest.fn(async (_id, { updateData }) => {
      Object.assign(box, updateData)
      box.enforceInvariants()
      return box
    })
    const repository = { findOneOrFail: jest.fn().mockResolvedValue(box), update: persist, updateWhere: persist }
    const runnerRepository = { findOne: jest.fn(async () => report) }
    const jobs = { createJob: jest.fn().mockResolvedValue(undefined) }
    const adapter = v0?.adapter ?? new RunnerAdapterV2(repository as never, {} as never, jobs as never)
    if (!v0) Object.assign(adapter, { runnerRepository })
    await adapter.init(report as never)
    let currentLock: LockCode
    const locks = {
      lock: jest.fn(async (_key, _ttl, code) => {
        currentLock = code
        return true
      }),
      getCode: jest.fn(async () => currentLock),
      unlock: jest.fn().mockResolvedValue(undefined),
    }
    const runners = {
      findOneOrFail: jest.fn().mockResolvedValue(report),
      getRunnerApiVersion: jest.fn(async () => report.apiVersion),
    }
    const action = new BoxStartAction(
      runners as never,
      { create: jest.fn().mockResolvedValue(adapter) } as never,
      repository as never,
      {
        findOne: jest.fn().mockResolvedValue({ boxMetadata: {} }),
        isNestedVirtualizationEnabled: jest.fn().mockResolvedValue(true),
      } as never,
      { getOrThrow: () => 0.5 } as never,
      locks as never,
      {} as never,
      {} as never,
    )
    const manager = new BoxManager(
      repository as never,
      runners as never,
      {} as never,
      locks as never,
      action,
      {} as never,
      {} as never,
      { reasonFor: jest.fn(async (_box, reason) => reason) } as never,
    )
    return { box, report, runnerRepository, jobs, manager }
  }

  it.each(['stale heartbeat', 'missing start support', 'lookup failure'])(
    'retries the original start intent after %s recovers',
    async (failure) => {
      const f = await fixture()
      if (failure === 'stale heartbeat') f.report.lastChecked = new Date(Date.now() - 61_000)
      if (failure === 'missing start support') f.report.nestedVirtualizationStartEnabled = false
      if (failure === 'lookup failure')
        f.runnerRepository.findOne.mockRejectedValueOnce(new Error('lookup unavailable'))

      await f.manager.syncInstanceState(f.box.id)

      expect(f.box.state).toBe(BoxState.STOPPED)
      expect(f.box.desiredState).toBe(BoxDesiredState.STARTED)
      expect(f.box.pending).toBe(true)
      expect(f.box.errorReason).toMatch(/nested virtualization start support/i)
      expect(f.box.nestedVirtualization).toBe(false)
      expect(f.jobs.createJob).not.toHaveBeenCalled()

      f.report.lastChecked = new Date()
      f.report.nestedVirtualizationStartEnabled = true
      await f.manager.syncInstanceState(f.box.id)

      expect(f.jobs.createJob).toHaveBeenCalledTimes(1)
      expect(f.jobs.createJob.mock.calls[0][1]).toBe(JobType.START_BOX)
      expect(f.jobs.createJob.mock.calls[0][5]).toMatchObject({ nestedVirtualization: true })
      expect(f.box.state).toBe(BoxState.STARTING)
      expect(f.box.errorReason).toBeNull()
    },
  )

  it('retains a saved upgrade when the dispatch preflight loses capability, then retries', async () => {
    const f = await fixture()
    f.runnerRepository.findOne
      .mockResolvedValueOnce(f.report)
      .mockResolvedValueOnce({ ...f.report, nestedVirtualizationStartEnabled: false })

    await f.manager.syncInstanceState(f.box.id)

    expect(f.box.state).toBe(BoxState.STOPPED)
    expect(f.box.pending).toBe(true)
    expect(f.box.nestedVirtualization).toBe(true)
    expect(f.jobs.createJob).not.toHaveBeenCalled()

    await f.manager.syncInstanceState(f.box.id)

    expect(f.jobs.createJob).toHaveBeenCalledTimes(1)
    expect(f.jobs.createJob.mock.calls[0][5]).toMatchObject({ nestedVirtualization: true })
    expect(f.box.state).toBe(BoxState.STARTING)
    expect(f.box.errorReason).toBeNull()
  })

  it('preserves the existing error transition for an actual dispatch failure', async () => {
    const f = await fixture()
    f.jobs.createJob.mockRejectedValueOnce(new Error('enqueue failed'))

    await f.manager.syncInstanceState(f.box.id)

    expect(f.jobs.createJob).toHaveBeenCalledTimes(1)
    expect(f.box.nestedVirtualization).toBe(true)
    expect(f.box.state).toBe(BoxState.ERROR)
    expect(f.box.recoverable).toBe(false)
    expect(f.box.errorReason).toBe('enqueue failed')
  })

  it.each([false, true])('keeps V0 info timeout retryable after upgrade=%s without sending start', async (upgraded) => {
    let probes = 0
    let starts = 0
    const server = createServer((request, response) => {
      if (request.method === 'POST') starts++
      if (request.url === '/info') {
        probes++
        if (!upgraded || probes > 1) return
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ nestedVirtualizationEnabled: true, nestedVirtualizationStartEnabled: true }))
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const f = await fixture({
        adapter: new RunnerAdapterV0({ getOrThrow: () => 0.5 } as never),
        apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      })

      await f.manager.syncInstanceState(f.box.id)

      expect(f.box.state).toBe(BoxState.STOPPED)
      expect(f.box.pending).toBe(true)
      expect(f.box.nestedVirtualization).toBe(upgraded)
      expect(f.box.errorReason).toMatch(/nested virtualization start support/i)
      expect(probes).toBe(upgraded ? 2 : 1)
      expect(starts).toBe(0)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
