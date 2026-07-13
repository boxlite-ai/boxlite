/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { OnEvent } from '@nestjs/event-emitter'
import { nanoid } from 'nanoid'
import { BillingAccessService } from '../../billing/access/billing-access.service'
import { BillingEvents, WalletBalanceChangedEvent } from '../../billing/billing-events'
import { LockCode, RedisLockProvider } from '../common/redis-lock.provider'
import { BoxService } from './box.service'

const SWEEP_LOCK_KEY = 'billing-access:sweep'
const SWEEP_LOCK_TTL_SECONDS = 55
const ORGANIZATION_LOCK_TTL_SECONDS = 30
const ORGANIZATION_BATCH_SIZE = 500

@Injectable()
export class BillingEnforcementService {
  private readonly logger = new Logger(BillingEnforcementService.name)

  constructor(
    private readonly billingAccess: BillingAccessService,
    private readonly boxService: BoxService,
    private readonly locks: RedisLockProvider,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'billing-access-sweep', waitForCompletion: true })
  async sweep(): Promise<void> {
    if (!this.billingAccess.isEnabled()) return

    const sweepCode = new LockCode(nanoid())
    if (!(await this.locks.lock(SWEEP_LOCK_KEY, SWEEP_LOCK_TTL_SECONDS, sweepCode))) return

    try {
      const organizationIds = await this.billingAccess.listActiveOrganizationIds()
      for (let offset = 0; offset < organizationIds.length; offset += ORGANIZATION_BATCH_SIZE) {
        const batch = organizationIds.slice(offset, offset + ORGANIZATION_BATCH_SIZE)
        const evaluations = await this.billingAccess.evaluateMany(batch)
        for (const evaluation of evaluations) {
          if (!evaluation.hasAccess) await this.enforceOrganization(evaluation.organizationId)
        }
      }
    } catch (error) {
      this.logger.error('Billing access sweep failed', error)
    } finally {
      await this.locks.unlock(SWEEP_LOCK_KEY, sweepCode)
    }
  }

  async enforceOrganization(organizationId: string): Promise<void> {
    if (!this.billingAccess.isEnabled()) return

    const key = `billing-access:${organizationId}`
    const code = new LockCode(nanoid())
    if (!(await this.locks.lock(key, ORGANIZATION_LOCK_TTL_SECONDS, code))) return

    try {
      const evaluation = await this.billingAccess.evaluate(organizationId)
      if (evaluation.hasAccess) return

      for (const boxId of evaluation.activeBoxIds) {
        try {
          await this.boxService.stop(boxId, organizationId)
        } catch (error) {
          this.logger.warn(`Failed to stop unfunded Box ${boxId} for organization ${organizationId}: ${error}`)
        }
      }
    } finally {
      await this.locks.unlock(key, code)
    }
  }

  @OnEvent(BillingEvents.WALLET_BALANCE_CHANGED)
  async handleWalletBalanceChanged(event: WalletBalanceChangedEvent): Promise<void> {
    try {
      await this.enforceOrganization(event.organizationId)
    } catch (error) {
      this.logger.error(`Billing enforcement failed after wallet change for ${event.organizationId}`, error)
    }
  }
}
