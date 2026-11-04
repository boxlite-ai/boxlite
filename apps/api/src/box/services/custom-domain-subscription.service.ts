/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { HttpException, Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import axios from 'axios'
import { DataSource } from 'typeorm'
import { TypedConfigService } from '../../config/typed-config.service'

export type DomainSubscription = 'active' | 'required' | 'unavailable'

/** Interprets Commerce's effective entitlement, independently of numeric Box limits. */
export function subscriptionExpiry(data: unknown, now: number): number | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid subscription response')
  if (Object.keys(data).length === 0) return null
  const plan = (data as { plan?: unknown }).plan
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('Invalid subscription plan')
  const { status, entitlements, cycleTo } = plan as Record<string, unknown>
  if (entitlements !== undefined && entitlements !== 'active' && entitlements !== 'suspended') {
    throw new Error('Invalid subscription entitlements')
  }
  if (status !== 'active' && status !== 'past_due' && status !== 'canceled') {
    throw new Error('Invalid subscription status')
  }
  if (status === 'canceled' || entitlements === 'suspended' || (status === 'past_due' && entitlements !== 'active')) {
    return null
  }
  const end = typeof cycleTo === 'string' ? Date.parse(cycleTo) : NaN
  if (!Number.isFinite(end)) throw new Error('Invalid subscription cycle')
  return end > now ? Math.min(end, now + 5 * 60_000) : null
}

export function requireDomainSubscription(status: DomainSubscription): void {
  if (status === 'active') return
  throw new HttpException(
    status === 'required'
      ? {
          code: 'subscription_required',
          message: 'An active organization subscription is required for custom domains.',
        }
      : { code: 'subscription_not_ready', message: 'Subscription eligibility is unavailable. Refresh in Dashboard.' },
    status === 'required' ? 403 : 409,
  )
}

@Injectable()
export class CustomDomainSubscriptionService {
  constructor(
    private readonly db: DataSource,
    private readonly config: TypedConfigService,
  ) {}

  async read(organizationId: string): Promise<DomainSubscription> {
    const [row]: { eligible: boolean | null; valid: boolean }[] = await this.db.query(
      `SELECT eligible, valid_until > now() AS valid FROM custom_domain_subscription WHERE organization_id = $1`,
      [organizationId],
    )
    if (row?.eligible === false) return 'required'
    return row?.eligible && row.valid ? 'active' : 'unavailable'
  }

  /** Coalesce across API replicas; a lost or expired refresh lease cannot publish a result. */
  async refresh(organizationId: string): Promise<DomainSubscription> {
    await this.db.query(
      `INSERT INTO custom_domain_subscription (organization_id)
       SELECT id FROM organization WHERE id = $1 ON CONFLICT DO NOTHING`,
      [organizationId],
    )
    const owner = randomUUID()
    const [claimed]: [unknown[], number] = await this.db.query(
      `UPDATE custom_domain_subscription SET refresh_owner = $2, refresh_until = now() + interval '10 seconds'
       WHERE organization_id = $1 AND refresh_until <= now()
         AND (checked_at IS NULL OR checked_at <= now() - interval '30 seconds') RETURNING organization_id`,
      [organizationId, owner],
    )
    if (claimed.length === 0) return this.read(organizationId)
    try {
      const base = this.config.get('billingApiUrl')?.trim()
      const token = this.config.get('usageExport.token')?.trim()
      if (!base || !token) throw new Error('Commerce is unavailable')
      const url = new URL(base)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('Invalid Commerce endpoint')
      }
      const { data } = await axios.get<unknown>(
        `${base.replace(/\/+$/, '')}/organization/${encodeURIComponent(organizationId)}/plan`,
        { timeout: 2_000, maxRedirects: 0, headers: { authorization: `Bearer ${token}` } },
      )
      const expires = subscriptionExpiry(data, Date.now())
      await this.db.transaction(async (manager) => {
        const [changed]: [unknown[], number] = await manager.query(
          `UPDATE custom_domain_subscription SET eligible = $3,
             valid_until = LEAST($4::timestamptz, now() + interval '5 minutes'), checked_at = now(),
             refresh_owner = NULL, refresh_until = '-infinity'
           WHERE organization_id = $1 AND refresh_owner = $2 AND refresh_until > now() RETURNING organization_id`,
          [organizationId, owner, expires !== null, new Date(expires ?? 0)],
        )
        if (changed.length && expires === null) {
          // Restoring a subscription must recheck DNS. Revoke the publication
          // token but retain its lease deadline so in-flight cloud work drains.
          await manager.query(
            `UPDATE custom_domain_config SET dns_valid_until = '-infinity', next_check_at = now(), lease_owner = NULL
            WHERE organization_id = $1 AND deleted_at IS NULL`,
            [organizationId],
          )
        }
      })
    } catch {
      // An outage never renews the prior absolute grant. Keep only its original lifetime.
      await this.db.query(
        `UPDATE custom_domain_subscription SET checked_at = now()
        WHERE organization_id = $1 AND refresh_owner = $2 AND refresh_until > now()`,
        [organizationId, owner],
      )
    } finally {
      await this.db.query(
        `UPDATE custom_domain_subscription SET refresh_owner = NULL, refresh_until = '-infinity'
        WHERE organization_id = $1 AND refresh_owner = $2`,
        [organizationId, owner],
      )
    }
    return this.read(organizationId)
  }
}
