/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box } from '../entities/box.entity'
import { BoxRuntimeLease } from '../entities/box-runtime-lease.entity'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { RuntimeLeaseService } from './runtime-lease.service'

const BOX_ID = 'box000000001'
const RUNNER_ID = '11111111-1111-1111-1111-111111111111'
const EPOCH = '22222222-2222-2222-2222-222222222222'

/** `now` as the database reports it; every assertion is relative to this. */
const DB_NOW = new Date('2026-07-28T12:00:00.000Z')
const EXPIRED_AT = new Date(DB_NOW.getTime() - 30_000)
const STILL_VALID_AT = new Date(DB_NOW.getTime() + 30_000)

function makeLease(overrides: Partial<BoxRuntimeLease> = {}): BoxRuntimeLease {
  return {
    boxId: BOX_ID,
    runnerId: RUNNER_ID,
    runnerEpoch: EPOCH,
    runtimeGeneration: 7,
    sequence: 42,
    actualState: BoxState.STARTED,
    observedAt: DB_NOW,
    leaseExpiresAt: EXPIRED_AT,
    updatedAt: DB_NOW,
    ...overrides,
  } as BoxRuntimeLease
}

function makeBox(overrides: Partial<Box> = {}): Box {
  const box = {
    id: BOX_ID,
    runnerId: RUNNER_ID,
    runtimeGeneration: 7,
    runtimeAuthorized: true,
    runtimeUnavailable: false,
    state: BoxState.STARTED,
    desiredState: BoxDesiredState.STARTED,
    organizationId: 'org-1',
    name: 'a-box',
    public: false,
    authToken: 'tok',
    assertValid: jest.fn(),
    enforceInvariants: jest.fn().mockReturnValue({}),
    ...overrides,
  }
  return box as unknown as Box
}

/**
 * The service reads the clock through `databaseNow`, which issues a raw query.
 * Returning DB_NOW from that query is what lets these tests be deterministic
 * without faking timers — and it is also the behaviour under test: expiry must
 * be judged by the database's clock, not the process's.
 */
function makeHarness(opts: { box?: Box | null; lease?: BoxRuntimeLease | null } = {}) {
  const box = opts.box === undefined ? makeBox() : opts.box
  const lease = opts.lease === undefined ? makeLease() : opts.lease

  const manager = {
    findOne: jest.fn(async (entity: unknown) => (entity === Box ? box : lease)),
    // transitionRuntimeState snapshots the pre-change Box through the manager
    // so it can hand both versions to publishCommittedUpdate.
    create: jest.fn((_entity: unknown, plain: Record<string, unknown>) => ({ ...plain })),
    save: jest.fn(async (_entity: unknown, value: unknown) => value),
    update: jest.fn(async (..._args: unknown[]) => undefined),
    upsert: jest.fn(async () => undefined),
    query: jest.fn(async () => [{ now: DB_NOW }]),
  }

  const dataSource = {
    transaction: jest.fn(async (run: (m: typeof manager) => Promise<unknown>) => run(manager)),
    getRepository: jest.fn(() => ({ find: jest.fn(async () => []) })),
  }

  const config = { getOrThrow: jest.fn(() => 60) }
  const boxRepository = { publishCommittedUpdate: jest.fn() }
  const usageSink = { updateComputeCap: jest.fn(async () => false), transition: jest.fn(async () => undefined) }

  const service = new RuntimeLeaseService(
    dataSource as never,
    config as never,
    usageSink as never,
    boxRepository as never,
  )

  return { service, manager, dataSource, boxRepository, usageSink, box, lease }
}

function snapshotOf(lease: BoxRuntimeLease) {
  return {
    boxId: lease.boxId,
    runnerEpoch: lease.runnerEpoch,
    runtimeGeneration: lease.runtimeGeneration,
    sequence: lease.sequence,
    leaseExpiresAt: lease.leaseExpiresAt,
  }
}

describe('RuntimeLeaseService.reconcileExpiredCandidate', () => {
  it('faults a Box whose lease expired while it was still authorized', async () => {
    const h = makeHarness()

    await expect(h.service.reconcileExpiredCandidate(snapshotOf(h.lease!))).resolves.toBe(true)

    // The runtime is gone but the disk is not: the Box must end up visibly
    // broken and recoverable rather than still claiming to run.
    const update = h.manager.update.mock.calls[0][2] as Record<string, unknown>
    expect(update).toMatchObject({
      state: BoxState.ERROR,
      runtimeUnavailable: true,
      recoverable: true,
      pending: false,
    })
  })

  it('leaves a lease renewed since the sweep read alone', async () => {
    // The sweep selects candidates outside the transaction. A renewal landing
    // in between pushes leaseExpiresAt into the future, and the row must
    // survive on that basis alone.
    //
    // The snapshot has to agree with the row for this to test anything: if the
    // candidate still carried the pre-renewal expiry, matchesSnapshot would
    // reject it first and the expiry re-check would never run. Deleting that
    // re-check from the service must fail this test — verified by mutation.
    const renewed = makeLease({ leaseExpiresAt: STILL_VALID_AT })
    const h = makeHarness({ lease: renewed })

    await expect(h.service.reconcileExpiredCandidate(snapshotOf(renewed))).resolves.toBe(false)
    expect(h.manager.update).not.toHaveBeenCalled()
    expect(h.boxRepository.publishCommittedUpdate).not.toHaveBeenCalled()
  })

  it('ignores a candidate whose lease was superseded by a newer generation', async () => {
    const h = makeHarness({ lease: makeLease({ runtimeGeneration: 9 }) })
    const stale = { ...snapshotOf(h.lease!), runtimeGeneration: 7 }

    await expect(h.service.reconcileExpiredCandidate(stale)).resolves.toBe(false)
    expect(h.manager.update).not.toHaveBeenCalled()
  })

  it('demotes the lease to UNKNOWN instead of faulting when the Box no longer matches', async () => {
    // Box moved to a different runner: this lease is no longer evidence of
    // anything, but it is also not grounds for faulting the Box.
    const h = makeHarness({ box: makeBox({ runnerId: 'aaaaaaaa-0000-0000-0000-000000000000' }) })

    await expect(h.service.reconcileExpiredCandidate(snapshotOf(h.lease!))).resolves.toBe(false)
    expect(h.manager.save).toHaveBeenCalledWith(BoxRuntimeLease, expect.objectContaining({ actualState: BoxState.UNKNOWN }))
    expect(h.manager.update).not.toHaveBeenCalled()
  })

  it('does not fault a Box whose runtime authorization was already cleared', async () => {
    // This is the flag the lifecycle-job handlers clear on failure. If it is
    // false the runtime was already known to be gone; faulting again would
    // overwrite whatever state that path chose.
    const h = makeHarness({ box: makeBox({ runtimeAuthorized: false }) })

    await expect(h.service.reconcileExpiredCandidate(snapshotOf(h.lease!))).resolves.toBe(false)
    expect(h.manager.update).not.toHaveBeenCalled()
  })

  it('does not fault a Box the user asked to stop', async () => {
    const h = makeHarness({ box: makeBox({ desiredState: BoxDesiredState.STOPPED }) })

    await expect(h.service.reconcileExpiredCandidate(snapshotOf(h.lease!))).resolves.toBe(false)
    expect(h.manager.update).not.toHaveBeenCalled()
  })

  it('returns false when the lease row is gone', async () => {
    const h = makeHarness({ lease: null })
    await expect(h.service.reconcileExpiredCandidate(snapshotOf(makeLease()))).resolves.toBe(false)
    expect(h.manager.update).not.toHaveBeenCalled()
  })

  it('publishes the committed change only after the transaction returns', async () => {
    const h = makeHarness()
    const order: string[] = []
    h.dataSource.transaction.mockImplementation(async (run: (m: unknown) => Promise<unknown>) => {
      const result = await run(h.manager)
      order.push('commit')
      return result
    })
    h.boxRepository.publishCommittedUpdate.mockImplementation(() => order.push('publish'))

    await h.service.reconcileExpiredCandidate(snapshotOf(h.lease!))

    // Publishing inside the transaction would announce a state that a rollback
    // could still take back.
    expect(order).toEqual(['commit', 'publish'])
  })

  it('judges expiry by the database clock, not the process clock', async () => {
    const h = makeHarness()
    await h.service.reconcileExpiredCandidate(snapshotOf(h.lease!))
    expect(h.manager.query).toHaveBeenCalled()
  })
})
