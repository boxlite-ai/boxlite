/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { EntityManager, IsNull } from 'typeorm'
import { Box } from '../../box/entities/box.entity'
import { BoxRuntimeLease } from '../../box/entities/box-runtime-lease.entity'
import { Runner } from '../../box/entities/runner.entity'
import { BoxState } from '../../box/enums/box-state.enum'
import { Region } from '../../region/entities/region.entity'
import { BoxUsagePeriod } from '../entities/box-usage-period.entity'
import { MeteringMode, MeteringPolicy } from './metering-policy'

export interface UsagePeriodTransition {
  manager: EntityManager
  previousBox: Box | null
  currentBox: Box
  transitionAt: Date
  forceBoundary?: boolean
  modeOverride?: MeteringMode
}

type PeriodAllocation = Pick<
  BoxUsagePeriod,
  | 'boxId'
  | 'organizationId'
  | 'cpu'
  | 'gpu'
  | 'mem'
  | 'disk'
  | 'region'
  | 'boxClass'
  | 'regionType'
  | 'computeBillableUntil'
  | 'runtimeGeneration'
  | 'runnerEpoch'
>

@Injectable()
export class UsagePeriodWriter {
  constructor(private readonly policy: MeteringPolicy) {}

  async transition(input: UsagePeriodTransition): Promise<void> {
    const { manager, currentBox, transitionAt, forceBoundary = false } = input
    let mode = input.modeOverride ?? this.policy.resolve(currentBox)

    if (mode === MeteringMode.PRESERVE && !forceBoundary) {
      return
    }

    let openPeriod = await manager.findOne(BoxUsagePeriod, {
      where: { boxId: currentBox.id, endAt: IsNull() },
      lock: { mode: 'pessimistic_write' },
    })

    if (openPeriod && transitionAt.getTime() < openPeriod.startAt.getTime()) {
      throw new Error(
        `Usage transition ${transitionAt.toISOString()} is before open period start ${openPeriod.startAt.toISOString()} for Box ${currentBox.id}`,
      )
    }

    openPeriod = await this.closeExpiredComputeAndOpenDisk(manager, openPeriod, transitionAt)

    let runtimeLease: BoxRuntimeLease | null = null
    if (mode === MeteringMode.FULL) {
      await this.assertRunnerSupportsRuntimeLeases(manager, currentBox)
      runtimeLease = await this.findActiveLease(manager, currentBox, transitionAt)
      if (!runtimeLease) {
        mode = MeteringMode.DISK_ONLY
      }
    }

    if (mode === MeteringMode.NONE) {
      if (openPeriod) {
        await this.close(manager, openPeriod, transitionAt)
      }
      return
    }

    if (mode === MeteringMode.PRESERVE) {
      if (openPeriod) {
        await this.replace(manager, openPeriod, this.allocationFromPeriod(openPeriod), transitionAt)
      }
      return
    }

    const expectedAllocation = await this.allocationForBox(manager, currentBox, mode, openPeriod, runtimeLease)
    if (
      openPeriod &&
      mode === MeteringMode.FULL &&
      this.sameAllocationExceptComputeCap(openPeriod, expectedAllocation) &&
      expectedAllocation.computeBillableUntil &&
      (!openPeriod.computeBillableUntil ||
        expectedAllocation.computeBillableUntil.getTime() > openPeriod.computeBillableUntil.getTime())
    ) {
      openPeriod.computeBillableUntil = expectedAllocation.computeBillableUntil
      await manager.save(BoxUsagePeriod, openPeriod)
    }

    if (!forceBoundary && openPeriod && this.sameAllocation(openPeriod, expectedAllocation)) {
      return
    }

    if (openPeriod) {
      await this.close(manager, openPeriod, transitionAt)
    }
    await manager.save(BoxUsagePeriod, this.newPeriod(expectedAllocation, transitionAt))
  }

  async updateComputeCap(input: {
    manager: EntityManager
    boxId: string
    runnerEpoch: string
    runtimeGeneration: number
    leaseExpiresAt: Date
    observedAt: Date
  }): Promise<boolean> {
    const openPeriod = await input.manager.findOne(BoxUsagePeriod, {
      where: { boxId: input.boxId, endAt: IsNull() },
      lock: { mode: 'pessimistic_write' },
    })
    if (
      !openPeriod ||
      !this.hasCompute(openPeriod) ||
      openPeriod.runnerEpoch !== input.runnerEpoch ||
      openPeriod.runtimeGeneration !== input.runtimeGeneration ||
      !openPeriod.computeBillableUntil ||
      openPeriod.computeBillableUntil.getTime() < input.observedAt.getTime()
    ) {
      return false
    }

    if (input.leaseExpiresAt.getTime() !== openPeriod.computeBillableUntil.getTime()) {
      openPeriod.computeBillableUntil = input.leaseExpiresAt
      await input.manager.save(BoxUsagePeriod, openPeriod)
    }
    return true
  }

  private async closeExpiredComputeAndOpenDisk(
    manager: EntityManager,
    openPeriod: BoxUsagePeriod | null,
    transitionAt: Date,
  ): Promise<BoxUsagePeriod | null> {
    if (!openPeriod || !this.hasCompute(openPeriod)) {
      return openPeriod
    }

    const computeCap = openPeriod.computeBillableUntil ?? openPeriod.startAt
    if (transitionAt.getTime() <= computeCap.getTime()) {
      return openPeriod
    }

    await this.close(manager, openPeriod, computeCap)
    const diskPeriod = this.newPeriod(
      {
        ...this.allocationFromPeriod(openPeriod),
        cpu: 0,
        gpu: 0,
        mem: 0,
        computeBillableUntil: null,
        runtimeGeneration: null,
        runnerEpoch: null,
      },
      computeCap,
    )
    return manager.save(BoxUsagePeriod, diskPeriod)
  }

  private async replace(
    manager: EntityManager,
    openPeriod: BoxUsagePeriod,
    allocation: PeriodAllocation,
    transitionAt: Date,
  ): Promise<void> {
    await this.close(manager, openPeriod, transitionAt)
    await manager.save(BoxUsagePeriod, this.newPeriod(allocation, transitionAt))
  }

  private async close(manager: EntityManager, openPeriod: BoxUsagePeriod, transitionAt: Date): Promise<void> {
    openPeriod.endAt = transitionAt
    await manager.save(BoxUsagePeriod, openPeriod)
  }

  private newPeriod(allocation: PeriodAllocation, transitionAt: Date): BoxUsagePeriod {
    return Object.assign(new BoxUsagePeriod(), allocation, {
      startAt: transitionAt,
      endAt: null,
    })
  }

  private async allocationForBox(
    manager: EntityManager,
    box: Box,
    mode: MeteringMode.FULL | MeteringMode.DISK_ONLY,
    openPeriod: BoxUsagePeriod | null,
    runtimeLease: BoxRuntimeLease | null,
  ): Promise<PeriodAllocation> {
    const regionType =
      openPeriod?.region === box.region
        ? openPeriod.regionType
        : await manager
            .findOneOrFail(Region, {
              select: ['regionType'],
              where: { id: box.region },
            })
            .then((region) => region.regionType)

    return {
      boxId: box.id,
      organizationId: box.organizationId,
      cpu: mode === MeteringMode.FULL ? box.cpu : 0,
      gpu: mode === MeteringMode.FULL ? box.gpu : 0,
      mem: mode === MeteringMode.FULL ? box.mem : 0,
      disk: box.disk,
      region: box.region,
      boxClass: box.class,
      regionType,
      computeBillableUntil: mode === MeteringMode.FULL ? (runtimeLease?.leaseExpiresAt ?? null) : null,
      runtimeGeneration: mode === MeteringMode.FULL ? (runtimeLease?.runtimeGeneration ?? null) : null,
      runnerEpoch: mode === MeteringMode.FULL ? (runtimeLease?.runnerEpoch ?? null) : null,
    }
  }

  private async findActiveLease(manager: EntityManager, box: Box, transitionAt: Date): Promise<BoxRuntimeLease | null> {
    if (!box.runtimeAuthorized || !box.runnerId || box.runtimeGeneration <= 0) {
      return null
    }

    const lease = await manager.findOne(BoxRuntimeLease, {
      where: { boxId: box.id },
      lock: { mode: 'pessimistic_read' },
    })
    if (
      !lease ||
      lease.runnerId !== box.runnerId ||
      lease.runnerEpoch.length === 0 ||
      lease.runtimeGeneration !== box.runtimeGeneration ||
      lease.actualState !== BoxState.STARTED ||
      lease.leaseExpiresAt.getTime() <= transitionAt.getTime()
    ) {
      return null
    }
    return lease
  }

  private async assertRunnerSupportsRuntimeLeases(manager: EntityManager, box: Box): Promise<void> {
    if (!box.runnerId) {
      return
    }
    const runner = await manager.findOne(Runner, {
      select: ['apiVersion'],
      where: { id: box.runnerId },
    })
    if (runner && runner.apiVersion !== '2') {
      throw new Error(
        `Runner ${box.runnerId} uses API version ${runner.apiVersion}, which cannot prove actual runtime state for metering`,
      )
    }
  }

  private allocationFromPeriod(period: BoxUsagePeriod): PeriodAllocation {
    return {
      boxId: period.boxId,
      organizationId: period.organizationId,
      cpu: period.cpu,
      gpu: period.gpu,
      mem: period.mem,
      disk: period.disk,
      region: period.region,
      boxClass: period.boxClass,
      regionType: period.regionType,
      computeBillableUntil: period.computeBillableUntil,
      runtimeGeneration: period.runtimeGeneration,
      runnerEpoch: period.runnerEpoch,
    }
  }

  private sameAllocation(period: BoxUsagePeriod, expected: PeriodAllocation): boolean {
    return (
      period.boxId === expected.boxId &&
      period.organizationId === expected.organizationId &&
      period.cpu === expected.cpu &&
      period.gpu === expected.gpu &&
      period.mem === expected.mem &&
      period.disk === expected.disk &&
      period.region === expected.region &&
      period.boxClass === expected.boxClass &&
      period.regionType === expected.regionType &&
      this.sameDate(period.computeBillableUntil, expected.computeBillableUntil) &&
      period.runtimeGeneration === expected.runtimeGeneration &&
      period.runnerEpoch === expected.runnerEpoch
    )
  }

  private sameAllocationExceptComputeCap(period: BoxUsagePeriod, expected: PeriodAllocation): boolean {
    return (
      period.boxId === expected.boxId &&
      period.organizationId === expected.organizationId &&
      period.cpu === expected.cpu &&
      period.gpu === expected.gpu &&
      period.mem === expected.mem &&
      period.disk === expected.disk &&
      period.region === expected.region &&
      period.boxClass === expected.boxClass &&
      period.regionType === expected.regionType &&
      period.runtimeGeneration === expected.runtimeGeneration &&
      period.runnerEpoch === expected.runnerEpoch
    )
  }

  private hasCompute(period: Pick<BoxUsagePeriod, 'cpu' | 'gpu' | 'mem'>): boolean {
    return period.cpu > 0 || period.gpu > 0 || period.mem > 0
  }

  private sameDate(left: Date | null, right: Date | null): boolean {
    return left === right || (left !== null && right !== null && left.getTime() === right.getTime())
  }
}
