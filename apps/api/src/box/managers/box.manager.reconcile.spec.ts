/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxManager } from './box.manager'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { Box } from '../entities/box.entity'

type Candidate = { id: string; runnerId: string | null }

function buildHarness(opts: {
  candidates: Candidate[]
  apiVersion?: string
  failedStartJobs?: number
  boxLocked?: boolean
  globalLockAcquired?: boolean
}) {
  const updateWhere = jest.fn().mockResolvedValue(undefined)

  const queryBuilder: any = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(opts.candidates),
  }
  const boxRepository: any = {
    createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    updateWhere,
  }

  const collectQueryClauses = () =>
    [...queryBuilder.where.mock.calls, ...queryBuilder.andWhere.mock.calls].map((call: any[]) => String(call[0]))

  const runnerService: any = {
    getRunnerApiVersion: jest.fn().mockResolvedValue(opts.apiVersion ?? '2'),
  }

  const redisLockProvider: any = {
    lock: jest.fn().mockResolvedValue(opts.globalLockAcquired ?? true),
    unlock: jest.fn().mockResolvedValue(undefined),
    isLocked: jest.fn().mockResolvedValue(opts.boxLocked ?? false),
  }

  const jobRepository: any = {
    count: jest.fn().mockResolvedValue(opts.failedStartJobs ?? 0),
  }

  const manager = new BoxManager(
    boxRepository,
    runnerService,
    redisLockProvider,
    {} as any,
    {} as any,
    {} as any,
    jobRepository,
  )

  return { manager, updateWhere, runnerService, redisLockProvider, jobRepository, collectQueryClauses }
}

describe('BoxManager.reconcileErroredBoxes', () => {
  afterEach(() => jest.clearAllMocks())

  it('flips a recoverable ERROR box to STOPPED so the start flow can re-drive it', async () => {
    const { manager, updateWhere } = buildHarness({
      candidates: [{ id: 'box-1', runnerId: 'runner-1' }],
    })

    await manager.reconcileErroredBoxes()

    expect(updateWhere).toHaveBeenCalledTimes(1)
    expect(updateWhere).toHaveBeenCalledWith('box-1', {
      updateData: { state: BoxState.STOPPED, errorReason: null, recoverable: false },
      whereCondition: {
        state: BoxState.ERROR,
        pending: false,
        desiredState: BoxDesiredState.STARTED,
        runnerId: 'runner-1',
      },
    })
  })

  it('keeps reconciled boxes pending because STOPPED is only a recovery waypoint toward STARTED', () => {
    const box = new Box('us-east-1', 'box-1')
    box.state = BoxState.ERROR
    box.desiredState = BoxDesiredState.STARTED
    box.pending = false

    Object.assign(box, { state: BoxState.STOPPED, errorReason: null, recoverable: false })
    const invariantChanges = box.enforceInvariants()

    expect(invariantChanges.pending).toBe(true)
    expect(box.pending).toBe(true)
    expect(box.state).toBe(BoxState.STOPPED)
    expect(box.desiredState).toBe(BoxDesiredState.STARTED)
  })

  it('does not gate eligibility on the storage-only recoverable flag, so split-brain ERROR boxes qualify', async () => {
    const { manager, updateWhere, collectQueryClauses } = buildHarness({
      // A split-brain box (CREATE failed late while the box exists on the runner)
      // is reported with recoverable=false; it must still be eligible for reconcile.
      candidates: [{ id: 'box-splitbrain', runnerId: 'runner-1' }],
    })

    await manager.reconcileErroredBoxes()

    const clauses = collectQueryClauses()
    // The errors #578 targets (split-brain, timeout) are recoverable=false. Pre-filtering on
    // box.recoverable (set true only for storage-full) would make the loop recover nothing.
    expect(clauses.some((clause) => clause.includes('recoverable'))).toBe(false)
    // Eligibility is still scoped to ERROR boxes that want to be STARTED.
    expect(clauses.some((clause) => clause.includes('box.state'))).toBe(true)
    expect(clauses.some((clause) => clause.includes('desiredState'))).toBe(true)
    // And such a (non-recoverable) box is still driven back toward STARTED.
    expect(updateWhere).toHaveBeenCalledWith('box-splitbrain', {
      updateData: { state: BoxState.STOPPED, errorReason: null, recoverable: false },
      whereCondition: {
        state: BoxState.ERROR,
        pending: false,
        desiredState: BoxDesiredState.STARTED,
        runnerId: 'runner-1',
      },
    })
  })

  it('guards the atomic transition with the same stable fields used for eligibility', async () => {
    const { manager, updateWhere } = buildHarness({
      candidates: [{ id: 'box-1', runnerId: 'runner-1' }],
    })

    await manager.reconcileErroredBoxes()

    expect(updateWhere).toHaveBeenCalledWith('box-1', {
      updateData: { state: BoxState.STOPPED, errorReason: null, recoverable: false },
      whereCondition: {
        state: BoxState.ERROR,
        pending: false,
        desiredState: BoxDesiredState.STARTED,
        runnerId: 'runner-1',
      },
    })
  })

  it('does not retry a box that already hit the recovery attempt ceiling', async () => {
    const { manager, updateWhere, jobRepository } = buildHarness({
      candidates: [{ id: 'box-1', runnerId: 'runner-1' }],
      failedStartJobs: 5, // MAX_RECOVER_ATTEMPTS
    })

    await manager.reconcileErroredBoxes()

    expect(jobRepository.count).toHaveBeenCalledTimes(1)
    expect(updateWhere).not.toHaveBeenCalled()
  })

  it('skips boxes on non-v2 runners', async () => {
    const { manager, updateWhere, jobRepository } = buildHarness({
      candidates: [{ id: 'box-1', runnerId: 'runner-1' }],
      apiVersion: '1',
    })

    await manager.reconcileErroredBoxes()

    expect(jobRepository.count).not.toHaveBeenCalled()
    expect(updateWhere).not.toHaveBeenCalled()
  })

  it('skips boxes the sync loop is already holding a lock on', async () => {
    const { manager, updateWhere } = buildHarness({
      candidates: [{ id: 'box-1', runnerId: 'runner-1' }],
      boxLocked: true,
    })

    await manager.reconcileErroredBoxes()

    expect(updateWhere).not.toHaveBeenCalled()
  })

  it('bails out without scanning when the global lock is held by another worker', async () => {
    const { manager, updateWhere, redisLockProvider } = buildHarness({
      candidates: [{ id: 'box-1', runnerId: 'runner-1' }],
      globalLockAcquired: false,
    })

    await manager.reconcileErroredBoxes()

    expect(updateWhere).not.toHaveBeenCalled()
    expect(redisLockProvider.unlock).not.toHaveBeenCalled()
  })
})
