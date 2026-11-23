/* Copyright 2026 BoxLite AI. SPDX-License-Identifier: AGPL-3.0 */
import { ForbiddenException, Injectable } from '@nestjs/common'
import { DataSource, EntityManager } from 'typeorm'

import { analyticsNoticeVersion } from '../../../../shared/console-analytics'

export interface AnalyticsSubjects {
  users: string[]
  organizations: string[]
}

type Decision = { allowed: boolean; notice_version: number; decided_at: Date }

@Injectable()
export class AnalyticsConsentService {
  constructor(private readonly db: DataSource) {}

  async preference(userId: string) {
    const [row]: Decision[] = await this.db.query(
      'SELECT allowed, notice_version, decided_at FROM product_analytics_consent WHERE user_id = $1',
      [userId],
    )
    const current = row && (!row.allowed || row.notice_version === analyticsNoticeVersion)
    return {
      allowed: current ? row.allowed : null,
      version: analyticsNoticeVersion,
      decidedAt: current ? row.decided_at.toISOString() : null,
    }
  }

  async decide(userId: string, allowed: boolean) {
    await this.db.transaction(async (manager) => {
      // Announce a pending decision to other dispatchers before waiting for active sends.
      await manager.query("SELECT pg_advisory_xact_lock(hashtextextended('product_analytics_consent:' || $1, 0))", [
        userId,
      ])
      await manager.query(
        `INSERT INTO product_analytics_consent AS existing (user_id, allowed, notice_version)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id) DO UPDATE SET allowed = excluded.allowed, notice_version = excluded.notice_version,
        decided_at = clock_timestamp()
      WHERE (existing.allowed, existing.notice_version) IS DISTINCT FROM (excluded.allowed, excluded.notice_version)`,
        [userId, allowed, analyticsNoticeVersion],
      )
    })
    return this.preference(userId)
  }

  async requireMember(userId: string, organizationId: string) {
    const rows = await this.db.query('SELECT 1 FROM organization_user WHERE "userId" = $1 AND "organizationId" = $2', [
      userId,
      organizationId,
    ])
    if (!rows.length) throw new ForbiddenException('Organization membership required')
  }

  async consoleEnabledFrom(userId: string, organizationId: string): Promise<string | null> {
    const [row] = await this.db.query(
      `SELECT greatest(person.decided_at, creator.decided_at) AS since
      FROM organization o JOIN product_analytics_consent creator ON creator.user_id = o."createdBy"
      JOIN product_analytics_consent person ON person.user_id = $1
      WHERE o.id = $2 AND person.allowed AND creator.allowed AND person.notice_version = $3 AND creator.notice_version = $3`,
      [userId, organizationId, analyticsNoticeVersion],
    )
    return row?.since.toISOString() ?? null
  }

  private async requiredUsers(manager: EntityManager, subjects: AnalyticsSubjects) {
    const organizations = [...new Set(subjects.organizations)]
    const users = new Set(subjects.users)
    if (organizations.length) {
      const rows: { createdBy: string }[] = await manager.query(
        'SELECT "createdBy" FROM organization WHERE id = ANY($1::uuid[]) ORDER BY id FOR KEY SHARE',
        [organizations],
      )
      if (rows.length !== organizations.length) return []
      for (const row of rows) users.add(row.createdBy)
    }
    return [...users].sort()
  }

  /** Hold the same decision rows that withdrawal updates until the bounded send finishes. */
  async dispatch(subjects: AnalyticsSubjects, occurredAt: Date, send: () => Promise<void>): Promise<boolean> {
    if (!Number.isFinite(occurredAt.getTime()) || occurredAt.getTime() > Date.now()) return false
    return this.db.transaction(async (manager) => {
      await manager.query("SET LOCAL lock_timeout = '250ms'")
      await manager.query("SET LOCAL statement_timeout = '1s'")
      const users = await this.requiredUsers(manager, subjects)
      if (!users.length) return false
      const rows: Decision[] = await manager.query(
        `SELECT allowed, notice_version, decided_at FROM product_analytics_consent
        WHERE user_id = ANY($1::varchar[]) AND decided_at <= $2::timestamptz
          AND pg_try_advisory_xact_lock_shared(hashtextextended('product_analytics_consent:' || user_id, 0))
        ORDER BY user_id FOR SHARE`,
        [users, occurredAt],
      )
      if (
        rows.length !== users.length ||
        rows.some((row) => !row.allowed || row.notice_version !== analyticsNoticeVersion)
      )
        return false
      await send()
      return true
    })
  }
}
