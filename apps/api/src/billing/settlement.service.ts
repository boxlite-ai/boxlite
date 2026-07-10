/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { RatingService } from './rating/rating.service'
import { WalletService } from './wallet.service'

@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name)

  constructor(
    private readonly ratingService: RatingService,
    private readonly walletService: WalletService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'settle-billing-periods' })
  async scheduledSweep(): Promise<void> {
    const result = await this.settleClosedPeriods()
    if (result.rated || result.ratingSkipped || result.debited || result.debitSkipped) {
      this.logger.log(
        `settlement sweep: rated ${result.rated}, rating skipped ${result.ratingSkipped}, ` +
          `debited ${result.debited}, debit skipped ${result.debitSkipped}`,
      )
    }
  }

  async settleClosedPeriods(): Promise<{
    rated: number
    ratingSkipped: number
    debited: number
    debitSkipped: number
  }> {
    const rating = await this.ratingService.rateClosedPeriods()
    const debit = await this.walletService.debitRatedPeriods()
    return {
      rated: rating.rated,
      ratingSkipped: rating.skipped,
      debited: debit.debited,
      debitSkipped: debit.skipped,
    }
  }
}
