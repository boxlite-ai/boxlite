/* Copyright 2026 BoxLite AI. SPDX-License-Identifier: AGPL-3.0 */
import { InjectRedis } from '@nestjs-modules/ioredis'
import { ForbiddenException, Injectable } from '@nestjs/common'
import Redis from 'ioredis'
import { DataSource } from 'typeorm'
import { analyticsNoticeVersion } from '../../../../shared/console-analytics'

export interface AnalyticsSubjects {
  users: string[]
  organizations: string[]
}

type Decision = { allowed: boolean | null; notice_version: number | null; decided_at: Date | null }
type Subject = 'creator' | 'grant'
const ttlMs = 30_000
export const analyticsConsentCacheKey = (kind: Subject, id: string) =>
  `analytics:consent:v${analyticsNoticeVersion}:${kind}:${id}`

function preference(row?: Decision) {
  const current = row?.allowed === false || (row?.allowed === true && row.notice_version === analyticsNoticeVersion)
  return {
    allowed: current ? row.allowed : null,
    version: analyticsNoticeVersion,
    decidedAt: current ? row.decided_at!.toISOString() : null,
  }
}

@Injectable()
export class AnalyticsConsentService {
  private readonly pendingReads = new Map<string, Promise<string>>()

  constructor(
    private readonly db: DataSource,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async preference(userId: string) {
    const [row]: Decision[] = await this.db.query(
      'SELECT allowed, notice_version, decided_at FROM product_analytics_consent WHERE user_id = $1',
      [userId],
    )
    return preference(row)
  }

  async decide(userId: string, allowed: boolean) {
    const [row]: Decision[] = await this.db.query(
      `INSERT INTO product_analytics_consent AS existing (user_id, allowed, notice_version)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET allowed = excluded.allowed, notice_version = excluded.notice_version,
         decided_at = clock_timestamp()
       WHERE (existing.allowed, existing.notice_version) IS DISTINCT FROM (excluded.allowed, excluded.notice_version)
       RETURNING allowed, notice_version, decided_at`,
      [userId, allowed, analyticsNoticeVersion],
    )
    // A saved preference stands even when best-effort cache invalidation fails.
    if (this.redis.status === 'ready') {
      void this.redis.del(analyticsConsentCacheKey('grant', userId)).catch(() => {})
    }
    return row ? preference(row) : this.preference(userId)
  }

  async requireMember(userId: string, organizationId: string) {
    const rows = await this.db.query('SELECT 1 FROM organization_user WHERE "userId" = $1 AND "organizationId" = $2', [
      userId,
      organizationId,
    ])
    if (!rows.length) throw new ForbiddenException('Organization membership required')
  }

  async consolePreference(userId: string, organizationId: string) {
    const [row]: (Decision & { since: Date | null })[] = await this.db.query(
      `SELECT person.allowed, person.notice_version, person.decided_at,
         CASE WHEN person.allowed AND creator.allowed AND person.notice_version = $3 AND creator.notice_version = $3
              THEN greatest(person.decided_at, creator.decided_at) END AS since
       FROM organization_user member JOIN organization o ON o.id = member."organizationId"
       LEFT JOIN product_analytics_consent person ON person.user_id = member."userId"
       LEFT JOIN product_analytics_consent creator ON creator.user_id = o."createdBy"
       WHERE member."userId" = $1 AND member."organizationId" = $2`,
      [userId, organizationId, analyticsNoticeVersion],
    )
    if (!row) throw new ForbiddenException('Organization membership required')
    return { ...preference(row), enabledFrom: row.since?.toISOString() ?? null }
  }

  private cached(kind: Subject, id: string): Promise<string> {
    const key = analyticsConsentCacheKey(kind, id)
    let pending = this.pendingReads.get(key)
    if (!pending) {
      pending = this.readSubject(kind, id, key).finally(() => this.pendingReads.delete(key))
      this.pendingReads.set(key, pending)
    }
    return pending
  }

  private async readSubject(kind: Subject, id: string, key: string): Promise<string> {
    const cached = await this.redis.get(key)
    if (cached !== null) return cached
    const expiresAt = Date.now() + ttlMs
    const [row]: { value: string }[] =
      kind === 'creator'
        ? await this.db.query('SELECT "createdBy" AS value FROM organization WHERE id = $1', [id])
        : await this.db.query(
            `SELECT ceil(extract(epoch FROM decided_at) * 1000)::bigint::text AS value
           FROM product_analytics_consent WHERE user_id = $1 AND allowed AND notice_version = $2`,
            [id, analyticsNoticeVersion],
          )
    const value = row?.value ?? ''
    // Cache misses and denials, too. Slow reads must not extend a stale decision's lifetime.
    if (Date.now() >= expiresAt) return ''
    await this.redis.set(key, value, 'PXAT', expiresAt, 'NX')
    return value
  }

  async dispatch(subjects: AnalyticsSubjects, occurredAt: Date, send: () => Promise<void>): Promise<boolean> {
    const at = occurredAt.getTime()
    if (!Number.isFinite(at) || at > Date.now() || this.redis.status !== 'ready') return false
    const creators = await Promise.all([...new Set(subjects.organizations)].map((id) => this.cached('creator', id)))
    if (creators.includes('')) return false
    const users = new Set([...subjects.users, ...creators])
    if (!users.size) return false
    const grants = await Promise.all([...users].map((id) => this.cached('grant', id)))
    if (!grants.every((since) => /^\d+$/.test(since) && Number(since) <= at)) return false
    await send()
    return true
  }
}
