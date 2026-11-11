/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { Injectable, Logger } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'
import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { TypedConfigService } from '../../config/typed-config.service'
import { CustomDomainSubscriptionService } from './custom-domain-subscription.service'
import { CustomDomainDnsService, DomainSetupError } from './custom-domain-dns.service'
import { CustomDomainGcpService } from './custom-domain-gcp.service'
import { CustomDomainRow } from './custom-domain-policy'

@Injectable()
export class CustomDomainWorkerService {
  private running = false
  private readonly logger = new Logger(CustomDomainWorkerService.name)
  constructor(
    private readonly db: DataSource,
    private readonly config: TypedConfigService,
    private readonly subscriptions: CustomDomainSubscriptionService,
    private readonly dns: CustomDomainDnsService,
    private readonly provider: CustomDomainGcpService,
  ) {}

  @Interval(5_000)
  async reconcileDue(): Promise<void> {
    if (this.running || !this.config.get('customDomains.enabled') || this.config.get('skipConnections')) return
    this.running = true
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, async () => {
          for (let index = 0; index < 4; index++) {
            const row = await this.claim()
            if (!row) break
            await this.reconcile(row)
          }
        }),
      )
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    } catch (error) {
      this.logger.error(
        'Custom domain reconciliation database failure',
        error instanceof Error ? error.message : 'unknown',
      )
    } finally {
      this.running = false
    }
  }

  private async claim(): Promise<CustomDomainRow | undefined> {
    return this.db.transaction(async (manager) => {
      // A short advisory transaction lock serializes lease selection across replicas, not DNS/cloud work.
      await manager.query(`SET LOCAL lock_timeout = '5s'`)
      await manager.query(`SELECT pg_advisory_xact_lock(1793764800)`)
      const [row]: CustomDomainRow[] = await manager.query(`SELECT c.* FROM custom_domain_config c
        WHERE c.next_check_at <= now() AND c.lease_until <= now()
          AND NOT EXISTS (SELECT 1 FROM custom_domain_config busy WHERE busy.hostname = c.hostname AND busy.lease_until > now())
        ORDER BY c.next_check_at, c.id LIMIT 1 FOR UPDATE SKIP LOCKED`)
      if (!row) return
      row.lease_owner = randomUUID()
      await manager.query(
        `UPDATE custom_domain_config SET lease_owner = $2, lease_until = now() + interval '2 minutes' WHERE id = $1`,
        [row.id, row.lease_owner],
      )
      return row
    })
  }

  private async reconcile(row: CustomDomainRow) {
    try {
      let subscriptionExpiresAt = 0
      if (!row.deleted_at) {
        const subscription = await this.subscriptions.refresh(row.organization_id)
        if (subscription.status !== 'active')
          throw new DomainSetupError(
            subscription.status === 'required' ? 'subscription_required' : 'subscription_not_ready',
            subscription.status === 'required',
          )
        subscriptionExpiresAt = subscription.expiresAt
        if (!row.domain_id && row.challenge_expires_at.getTime() <= Date.now())
          throw new DomainSetupError('challenge_expired', true)
        await this.dns.verify(row.hostname, row.challenge)
        const admitted = await this.admit(row, subscriptionExpiresAt)
        if (!admitted) return
        row = admitted
      }
      const result =
        row.phase === 'ready' && !row.deleted_at
          ? {
              state: row.provider_state,
              phase: row.phase,
              expires: await this.dns.verifyTls(row.hostname),
              cleaned: false,
            }
          : await this.provider.reconcile(row)
      if (result.phase === 'ready' && !row.deleted_at && row.phase !== 'ready') {
        const servedExpiry = await this.dns.verifyTls(row.hostname)
        result.expires = new Date(Math.min(Date.parse(result.expires), Date.parse(servedExpiry))).toISOString()
      }
      // A tombstone is retained and periodically swept to catch ambiguous/timed-out creates.
      await this.db.query(
        `UPDATE custom_domain_config SET provider_state = $4,
        phase = CASE WHEN deleted_at IS NOT NULL THEN 'deleting' ELSE $5 END,
        dns_valid_until = CASE WHEN deleted_at IS NULL
          THEN LEAST(now() + interval '5 minutes', $8::timestamptz) ELSE '-infinity' END,
        certificate_valid_until = CASE WHEN deleted_at IS NULL AND $6::timestamptz IS NOT NULL
          THEN LEAST($6::timestamptz, now() + interval '5 minutes') ELSE '-infinity' END,
        error_code = NULL, attempts = 0, updated_at = now(),
        next_check_at = now() + CASE WHEN $7 THEN interval '1 day' ELSE interval '1 minute' END
        WHERE id = $1 AND generation = $2 AND lease_owner = $3 AND lease_until > now()`,
        [
          row.id,
          row.generation,
          row.lease_owner,
          result.state,
          result.phase,
          result.expires,
          result.cleaned,
          new Date(subscriptionExpiresAt),
        ],
      )
    } catch (error) {
      const failure = error instanceof DomainSetupError ? error : new DomainSetupError('verification_unavailable')
      await this.db.query(
        `UPDATE custom_domain_config SET error_code = $4::varchar, attempts = attempts + 1,
        phase = CASE
          WHEN deleted_at IS NULL AND $4::varchar = 'https_not_ready' THEN 'provisioning'
          WHEN deleted_at IS NULL AND $4::varchar = 'certificate_dns_mismatch' THEN 'pending_certificate_dns'
          ELSE phase END,
        dns_valid_until = CASE WHEN $5 THEN '-infinity' ELSE dns_valid_until END,
        next_check_at = now() + make_interval(secs => LEAST(3600, 30 * power(2, LEAST(attempts, 7)))::int), updated_at = now()
        WHERE id = $1 AND generation = $2 AND lease_owner = $3 AND lease_until > now()`,
        [row.id, row.generation, row.lease_owner, failure.code, failure.invalidateDns],
      )
    } finally {
      await this.db.query(
        `UPDATE custom_domain_config SET lease_owner = NULL, lease_until = '-infinity'
        WHERE id = $1 AND lease_owner = $2`,
        [row.id, row.lease_owner],
      )
    }
  }

  private async admit(row: CustomDomainRow, subscriptionExpiresAt: number): Promise<CustomDomainRow | undefined> {
    return this.db.transaction(async (manager) => {
      await manager.query(`SET LOCAL lock_timeout = '5s'`)
      const [organization] = await manager.query(`SELECT id FROM organization WHERE id = $1 FOR UPDATE`, [
        row.organization_id,
      ])
      if (!organization) return
      const [current]: CustomDomainRow[] = await manager.query(
        `SELECT * FROM custom_domain_config
        WHERE id = $1 AND generation = $2 AND lease_owner = $3 AND lease_until > now()
          AND deleted_at IS NULL AND (domain_id IS NOT NULL OR challenge_expires_at > now()) FOR UPDATE`,
        [row.id, row.generation, row.lease_owner],
      )
      if (!current) return
      const [subscription] = await manager.query(
        // now() is frozen at transaction start, possibly before waiting for the organization lock.
        `SELECT $1::timestamptz > clock_timestamp() AS valid`,
        [new Date(subscriptionExpiresAt)],
      )
      if (!subscription.valid) throw new DomainSetupError('subscription_not_ready')
      if (!current.domain_id) {
        const [domain] = await manager.query(
          `INSERT INTO domain (hostname, kind, organization_id)
          VALUES ($1, 'custom', $2) ON CONFLICT (hostname) DO NOTHING RETURNING id`,
          [row.hostname, row.organization_id],
        )
        if (!domain) throw new DomainSetupError('domain_already_owned')
        current.domain_id = domain.id
        current.phase = 'pending_certificate_dns'
        await manager.query(
          `UPDATE custom_domain_config SET domain_id = $2, phase = 'pending_certificate_dns' WHERE id = $1`,
          [row.id, domain.id],
        )
      }
      return current
    })
  }
}
