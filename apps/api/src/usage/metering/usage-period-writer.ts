/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { EntityManager, IsNull } from 'typeorm'
import { Box } from '../../box/entities/box.entity'
import { Region } from '../../region/entities/region.entity'
import { BoxUsagePeriod } from '../entities/box-usage-period.entity'
import { MeteringMode, MeteringPolicy } from './metering-policy'

export interface UsagePeriodTransition {
  manager: EntityManager
  previousBox: Box | null
  currentBox: Box
  transitionAt: Date
  forceBoundary?: boolean
}

type PeriodAllocation = Pick<
  BoxUsagePeriod,
  'boxId' | 'organizationId' | 'cpu' | 'gpu' | 'mem' | 'disk' | 'region' | 'boxClass' | 'regionType'
>

@Injectable()
export class UsagePeriodWriter {
  constructor(private readonly policy: MeteringPolicy) {}

  async transition(input: UsagePeriodTransition): Promise<void> {
    const { manager, currentBox, transitionAt, forceBoundary = false } = input
    const mode = this.policy.resolve(currentBox)

    if (mode === MeteringMode.PRESERVE && !forceBoundary) {
      return
    }

    const openPeriod = await manager.findOne(BoxUsagePeriod, {
      where: { boxId: currentBox.id, endAt: IsNull() },
      lock: { mode: 'pessimistic_write' },
    })

    if (openPeriod && transitionAt.getTime() < openPeriod.startAt.getTime()) {
      throw new Error(
        `Usage transition ${transitionAt.toISOString()} is before open period start ${openPeriod.startAt.toISOString()} for Box ${currentBox.id}`,
      )
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

    const expectedAllocation = await this.allocationForBox(manager, currentBox, mode, openPeriod)
    if (!forceBoundary && openPeriod && this.sameAllocation(openPeriod, expectedAllocation)) {
      return
    }

    if (openPeriod) {
      await this.close(manager, openPeriod, transitionAt)
    }
    await manager.save(BoxUsagePeriod, this.newPeriod(expectedAllocation, transitionAt))
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
      period.regionType === expected.regionType
    )
  }
}
