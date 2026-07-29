/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { EntityManager } from 'typeorm'
import { Box } from '../../box/entities/box.entity'
import { BoxRuntimeLease } from '../../box/entities/box-runtime-lease.entity'
import { Runner } from '../../box/entities/runner.entity'
import { BoxClass } from '../../box/enums/box-class.enum'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BoxState } from '../../box/enums/box-state.enum'
import { RegionType } from '../../region/enums/region-type.enum'
import { BoxUsagePeriod } from '../entities/box-usage-period.entity'
import { MeteringPolicy } from './metering-policy'
import { UsagePeriodWriter } from './usage-period-writer'

function makeBox(overrides: Partial<Box> = {}): Box {
  return {
    id: 'box000000001',
    organizationId: 'org-1',
    region: 'region-1',
    state: BoxState.STARTED,
    desiredState: BoxDesiredState.STARTED,
    cpu: 2,
    gpu: 1,
    mem: 4,
    disk: 10,
    class: BoxClass.SMALL,
    runnerId: '00000000-0000-0000-0000-000000000010',
    runtimeGeneration: 1,
    runtimeAuthorized: true,
    ...overrides,
  } as Box
}

function makeOpenPeriod(overrides: Partial<BoxUsagePeriod> = {}): BoxUsagePeriod {
  return Object.assign(new BoxUsagePeriod(), {
    id: 'period-1',
    boxId: 'box000000001',
    organizationId: 'org-1',
    startAt: new Date('2026-07-21T00:00:00.000Z'),
    endAt: null,
    computeBillableUntil: new Date('2026-07-23T00:00:00.000Z'),
    runtimeGeneration: 1,
    runnerEpoch: '00000000-0000-0000-0000-000000000020',
    cpu: 2,
    gpu: 1,
    mem: 4,
    disk: 10,
    region: 'region-1',
    boxClass: BoxClass.SMALL,
    regionType: RegionType.SHARED,
    ...overrides,
  })
}

function fakeManager(
  initialOpen: BoxUsagePeriod | null,
  lease: BoxRuntimeLease = Object.assign(new BoxRuntimeLease(), {
    boxId: 'box000000001',
    runnerId: '00000000-0000-0000-0000-000000000010',
    runnerEpoch: '00000000-0000-0000-0000-000000000020',
    runtimeGeneration: 1,
    sequence: 1,
    actualState: BoxState.STARTED,
    observedAt: new Date('2026-07-21T23:59:30.000Z'),
    leaseExpiresAt: new Date('2026-07-23T00:00:00.000Z'),
  }),
  runnerApiVersion = '2',
) {
  let open = initialOpen
  const saves: BoxUsagePeriod[] = []
  const manager = {
    findOne: jest.fn(async (entity: unknown) => {
      if (entity === BoxRuntimeLease) return lease
      if (entity === Runner) return { id: '00000000-0000-0000-0000-000000000010', apiVersion: runnerApiVersion }
      return open
    }),
    findOneOrFail: jest.fn(async () => ({ regionType: RegionType.SHARED })),
    save: jest.fn(async (_entity: unknown, period: BoxUsagePeriod) => {
      saves.push({ ...period } as BoxUsagePeriod)
      open = period.endAt === null ? period : null
      return period
    }),
  } as unknown as EntityManager

  return { manager, saves, getOpen: () => open }
}

describe('UsagePeriodWriter', () => {
  const transitionAt = new Date('2026-07-22T00:00:00.000Z')
  const writer = new UsagePeriodWriter(new MeteringPolicy())

  it('atomically replaces FULL with DISK_ONLY at the stop acceptance boundary', async () => {
    const currentBox = makeBox({ desiredState: BoxDesiredState.STOPPED })
    const fake = fakeManager(makeOpenPeriod())

    await writer.transition({
      manager: fake.manager,
      previousBox: makeBox(),
      currentBox,
      transitionAt,
    })

    expect(fake.saves).toHaveLength(2)
    expect(fake.saves[0]).toMatchObject({ endAt: transitionAt, cpu: 2 })
    expect(fake.saves[1]).toMatchObject({
      startAt: transitionAt,
      endAt: null,
      cpu: 0,
      mem: 0,
      gpu: 0,
      disk: 10,
    })
  })

  it('rejects FULL metering on a v0 runner instead of silently opening a disk-only period', async () => {
    const fake = fakeManager(makeOpenPeriod(), undefined, '0')

    await expect(
      writer.transition({
        manager: fake.manager,
        previousBox: makeBox(),
        currentBox: makeBox(),
        transitionAt,
      }),
    ).rejects.toThrow('cannot prove actual runtime state for metering')
    expect(fake.saves).toHaveLength(0)
  })

  it('does not split an already-correct allocation again', async () => {
    const currentBox = makeBox({ desiredState: BoxDesiredState.STOPPED })
    const fake = fakeManager(
      makeOpenPeriod({
        cpu: 0,
        mem: 0,
        gpu: 0,
        computeBillableUntil: null,
        runtimeGeneration: null,
        runnerEpoch: null,
      }),
    )

    await writer.transition({ manager: fake.manager, previousBox: currentBox, currentBox, transitionAt })
    await writer.transition({ manager: fake.manager, previousBox: currentBox, currentBox, transitionAt })

    expect(fake.saves).toHaveLength(0)
  })

  it('keeps the existing DISK_ONLY period open when a stop attempt enters ERROR', async () => {
    const currentBox = makeBox({
      state: BoxState.ERROR,
      desiredState: BoxDesiredState.STOPPED,
      runtimeAuthorized: false,
    })
    const openPeriod = makeOpenPeriod({
      cpu: 0,
      mem: 0,
      gpu: 0,
      computeBillableUntil: null,
      runtimeGeneration: null,
      runnerEpoch: null,
    })
    const fake = fakeManager(openPeriod)

    await writer.transition({ manager: fake.manager, previousBox: makeBox(), currentBox, transitionAt })

    expect(fake.saves).toHaveLength(0)
    expect(fake.getOpen()).toBe(openPeriod)
  })

  it('splits the period when resources change within the same metering mode', async () => {
    const previousBox = makeBox()
    const currentBox = makeBox({ cpu: 4 })
    const fake = fakeManager(makeOpenPeriod())

    await writer.transition({ manager: fake.manager, previousBox, currentBox, transitionAt })

    expect(fake.saves).toHaveLength(2)
    expect(fake.saves[1]).toMatchObject({ cpu: 4, startAt: transitionAt, endAt: null })
  })

  it('closes the open period without reopening when the box enters ERROR', async () => {
    const currentBox = makeBox({ state: BoxState.ERROR })
    const fake = fakeManager(makeOpenPeriod())

    await writer.transition({ manager: fake.manager, previousBox: makeBox(), currentBox, transitionAt })

    expect(fake.saves).toHaveLength(1)
    expect(fake.getOpen()).toBeNull()
    expect(fake.saves[0].endAt).toEqual(transitionAt)
  })

  it('forces a rollover boundary while preserving a transitional allocation', async () => {
    const currentBox = makeBox({ state: BoxState.STARTING })
    const fake = fakeManager(makeOpenPeriod({ cpu: 0, mem: 0, gpu: 0 }))

    await writer.transition({
      manager: fake.manager,
      previousBox: currentBox,
      currentBox,
      transitionAt,
      forceBoundary: true,
    })

    expect(fake.saves).toHaveLength(2)
    expect(fake.saves[1]).toMatchObject({ cpu: 0, mem: 0, gpu: 0, startAt: transitionAt, endAt: null })
  })

  it('never closes a period before it started when a supplied clock moves backwards', async () => {
    const periodStart = new Date('2026-07-22T00:00:01.000Z')
    const suppliedTransitionAt = new Date('2026-07-22T00:00:00.000Z')
    const currentBox = makeBox({ desiredState: BoxDesiredState.STOPPED })
    const fake = fakeManager(makeOpenPeriod({ startAt: periodStart }))

    await expect(
      writer.transition({
        manager: fake.manager,
        previousBox: makeBox(),
        currentBox,
        transitionAt: suppliedTransitionAt,
      }),
    ).rejects.toThrow('before open period start')

    expect(fake.saves).toHaveLength(0)
  })
})
