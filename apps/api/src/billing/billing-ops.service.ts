/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { WithInstrumentation } from '../common/decorators/otel.decorator'
import { Wallet } from './entities/wallet.entity'

const STALE_PAYMENT_SECONDS = 15 * 60
const BILLING_PIPELINE_LAG_SECONDS = 5 * 60

export interface BillingHealthSnapshot {
  pendingPaymentCount: number
  pendingPaymentOldestSeconds: number
  failedWebhookCount: number
  failedWebhookOldestSeconds: number
  negativeWalletCount: number
  lowestWalletBalanceCents: string
  unratedPeriodCount: number
  unratedPeriodOldestSeconds: number
  unsettledPeriodCount: number
  unsettledPeriodOldestSeconds: number
  pendingPayment: {
    topUpId: string
    organizationId: string
    providerReference: string | null
    lastError: string | null
  } | null
  failedWebhook: {
    providerEventId: string
    eventType: string
    organizationId: string | null
    topUpId: string | null
    providerReference: string | null
    lastError: string | null
  } | null
  negativeWallet: { organizationId: string; balanceCents: string } | null
  unratedPeriod: { usagePeriodArchiveId: string; organizationId: string; boxId: string } | null
  unsettledPeriod: { ratedPeriodId: string; organizationId: string; boxId: string } | null
}

export interface BillingHealthAlert {
  code: 'stale_pending_payment' | 'failed_payment_webhook' | 'negative_wallet_balance' | 'rating_lag' | 'settlement_lag'
  severity: 'warning' | 'error'
}

export function billingHealthAlerts(snapshot: BillingHealthSnapshot): BillingHealthAlert[] {
  const alerts: BillingHealthAlert[] = []
  if (snapshot.pendingPaymentCount > 0 && snapshot.pendingPaymentOldestSeconds > STALE_PAYMENT_SECONDS) {
    alerts.push({ code: 'stale_pending_payment', severity: 'warning' })
  }
  if (snapshot.failedWebhookCount > 0) alerts.push({ code: 'failed_payment_webhook', severity: 'error' })
  if (snapshot.negativeWalletCount > 0) alerts.push({ code: 'negative_wallet_balance', severity: 'error' })
  if (snapshot.unratedPeriodCount > 0 && snapshot.unratedPeriodOldestSeconds > BILLING_PIPELINE_LAG_SECONDS) {
    alerts.push({ code: 'rating_lag', severity: 'warning' })
  }
  if (snapshot.unsettledPeriodCount > 0 && snapshot.unsettledPeriodOldestSeconds > BILLING_PIPELINE_LAG_SECONDS) {
    alerts.push({ code: 'settlement_lag', severity: 'warning' })
  }
  return alerts
}

@Injectable()
export class BillingOpsService {
  private readonly logger = new Logger(BillingOpsService.name)

  constructor(@InjectRepository(Wallet) private readonly wallets: Repository<Wallet>) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'billing-health-check', waitForCompletion: true })
  @WithInstrumentation('billing_health_check')
  async scheduledHealthCheck(): Promise<void> {
    const snapshot = await this.collectHealth()
    for (const alert of billingHealthAlerts(snapshot)) {
      this.logger[alert.severity === 'error' ? 'error' : 'warn'](
        `[billing_alert] ${JSON.stringify({ code: alert.code, ...snapshot })}`,
      )
    }
  }

  async collectHealth(now = new Date()): Promise<BillingHealthSnapshot> {
    const [row] = await this.wallets.manager.query(
      `SELECT
        (SELECT COUNT(*)::int FROM top_up_record WHERE status = 'pending') AS "pendingPaymentCount",
        COALESCE((SELECT GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - MIN("createdAt"))))
                    FROM top_up_record WHERE status = 'pending'), 0)::float8 AS "pendingPaymentOldestSeconds",
        (SELECT COUNT(*)::int FROM payment_provider_event WHERE status = 'failed') AS "failedWebhookCount",
        COALESCE((SELECT GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - MIN("updatedAt"))))
                    FROM payment_provider_event WHERE status = 'failed'), 0)::float8 AS "failedWebhookOldestSeconds",
        (SELECT COUNT(*)::int FROM wallet WHERE ("freeBalanceCents" + "paidBalanceCents") < 0)
          AS "negativeWalletCount",
        COALESCE((SELECT MIN("freeBalanceCents" + "paidBalanceCents")::text FROM wallet), '0')
          AS "lowestWalletBalanceCents",
        (SELECT COUNT(*)::int FROM box_usage_period_archive a
          LEFT JOIN rated_period r ON r."usagePeriodArchiveId" = a.id WHERE r.id IS NULL) AS "unratedPeriodCount",
        COALESCE((SELECT GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - MIN(a."endAt"))))
          FROM box_usage_period_archive a
          LEFT JOIN rated_period r ON r."usagePeriodArchiveId" = a.id WHERE r.id IS NULL), 0)::float8
          AS "unratedPeriodOldestSeconds",
        (SELECT COUNT(*)::int FROM rated_period r
          LEFT JOIN wallet_transaction wt ON wt."ratedPeriodId" = r.id WHERE wt.id IS NULL) AS "unsettledPeriodCount",
        COALESCE((SELECT GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - MIN(r."ratedAt"))))
          FROM rated_period r
          LEFT JOIN wallet_transaction wt ON wt."ratedPeriodId" = r.id WHERE wt.id IS NULL), 0)::float8
          AS "unsettledPeriodOldestSeconds",
        (SELECT jsonb_build_object(
            'topUpId', id,
            'organizationId', "organizationId",
            'providerReference', "providerReference",
            'lastError', "reconcileLastError")
          FROM top_up_record WHERE status = 'pending' ORDER BY "createdAt", id LIMIT 1) AS "pendingPayment",
        (SELECT jsonb_build_object(
            'providerEventId', "providerEventId",
            'eventType', "eventType",
            'organizationId', payload->>'organizationId',
            'topUpId', payload->>'topUpId',
            'providerReference', "providerReference",
            'lastError', "lastError")
          FROM payment_provider_event WHERE status = 'failed' ORDER BY "updatedAt", id LIMIT 1)
          AS "failedWebhook",
        (SELECT jsonb_build_object(
            'organizationId', "organizationId",
            'balanceCents', ("freeBalanceCents" + "paidBalanceCents")::text)
          FROM wallet WHERE ("freeBalanceCents" + "paidBalanceCents") < 0
          ORDER BY ("freeBalanceCents" + "paidBalanceCents"), id LIMIT 1) AS "negativeWallet",
        (SELECT jsonb_build_object(
            'usagePeriodArchiveId', a.id,
            'organizationId', a."organizationId",
            'boxId', a."boxId")
          FROM box_usage_period_archive a
          LEFT JOIN rated_period r ON r."usagePeriodArchiveId" = a.id
          WHERE r.id IS NULL ORDER BY a."endAt", a.id LIMIT 1) AS "unratedPeriod",
        (SELECT jsonb_build_object(
            'ratedPeriodId', r.id,
            'organizationId', r."organizationId",
            'boxId', r."boxId")
          FROM rated_period r
          LEFT JOIN wallet_transaction wt ON wt."ratedPeriodId" = r.id
          WHERE wt.id IS NULL ORDER BY r."ratedAt", r.id LIMIT 1) AS "unsettledPeriod"`,
      [now],
    )
    return {
      pendingPaymentCount: Number(row.pendingPaymentCount),
      pendingPaymentOldestSeconds: Number(row.pendingPaymentOldestSeconds),
      failedWebhookCount: Number(row.failedWebhookCount),
      failedWebhookOldestSeconds: Number(row.failedWebhookOldestSeconds),
      negativeWalletCount: Number(row.negativeWalletCount),
      lowestWalletBalanceCents: String(row.lowestWalletBalanceCents),
      unratedPeriodCount: Number(row.unratedPeriodCount),
      unratedPeriodOldestSeconds: Number(row.unratedPeriodOldestSeconds),
      unsettledPeriodCount: Number(row.unsettledPeriodCount),
      unsettledPeriodOldestSeconds: Number(row.unsettledPeriodOldestSeconds),
      pendingPayment: row.pendingPayment ?? null,
      failedWebhook: row.failedWebhook ?? null,
      negativeWallet: row.negativeWallet ?? null,
      unratedPeriod: row.unratedPeriod ?? null,
      unsettledPeriod: row.unsettledPeriod ?? null,
    }
  }
}
