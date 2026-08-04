/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { IsNull, Repository } from 'typeorm'
import { BoxUsagePeriod } from '../usage/entities/box-usage-period.entity'
import { BoxUsagePeriodArchive } from '../usage/entities/box-usage-period-archive.entity'
import { BillingPeriodDto } from './dto/billing-period.dto'

@Injectable()
export class BillingService {
  constructor(
    @InjectRepository(BoxUsagePeriodArchive)
    private readonly archiveRepository: Repository<BoxUsagePeriodArchive>,
    @InjectRepository(BoxUsagePeriod)
    private readonly openPeriodRepository: Repository<BoxUsagePeriod>,
  ) {}

  /**
   * Oldest-`endAt`-first, matching commerce-rs's own ordering so a lagging
   * scan drains in the order periods actually closed.
   */
  async listUnbilled(limit: number): Promise<BillingPeriodDto[]> {
    const periods = await this.archiveRepository.find({
      where: { billingStatus: 'unbilled' },
      order: { endAt: 'ASC' },
      take: limit,
    })
    return periods.map(BillingPeriodDto.fromArchive)
  }

  /**
   * Compare-and-swap: only the caller that flips 'unbilled' -> 'billed' gets
   * `true`. Two concurrent billing rounds racing this call cannot both claim
   * the same period.
   */
  async markBilled(periodId: string): Promise<boolean> {
    const result = await this.archiveRepository
      .createQueryBuilder()
      .update(BoxUsagePeriodArchive)
      .set({ billingStatus: 'billed' })
      .where('id = :periodId', { periodId })
      .andWhere('billing_status = :unbilled', { unbilled: 'unbilled' })
      .execute()
    return (result.affected ?? 0) > 0
  }

  async fetchArchived(periodId: string): Promise<BillingPeriodDto | null> {
    const period = await this.archiveRepository.findOne({ where: { id: periodId } })
    return period ? BillingPeriodDto.fromArchive(period) : null
  }

  /** The hot table: periods still running, for F9 suspension exposure checks. */
  async listOpenForOrganization(organizationId: string): Promise<BillingPeriodDto[]> {
    const periods = await this.openPeriodRepository.find({
      where: { organizationId, endAt: IsNull() },
    })
    return periods.map(BillingPeriodDto.fromOpenPeriod)
  }
}
