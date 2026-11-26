/* Copyright 2026 BoxLite AI. SPDX-License-Identifier: AGPL-3.0 */
import { InjectRedis } from '@nestjs-modules/ioredis'
import { ForbiddenException, Injectable } from '@nestjs/common'
import { metrics } from '@opentelemetry/api'
import Redis from 'ioredis'
import { DataSource } from 'typeorm'
import { TypedConfigService } from '../../config/typed-config.service'
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

function sharedRead<T>(reads: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
  let pending = reads.get(key)
  if (!pending) {
    pending = read().finally(() => reads.delete(key))
    reads.set(key, pending)
  }
  return pending
}

@Injectable()
export class AnalyticsConsentService {
  private readonly cacheReads = new Map<string, Promise<string | null>>()
  private readonly databaseReads = new Map<string, Promise<string>>()
  private readonly sqlWaiters: (() => void)[] = []
  private readonly maxColdEvents: number
  private readonly maxSqlReads: number
  private activeSqlReads = 0
  private coldEvents = 0
  private readonly overflow = metrics.getMeter('').createCounter('posthog_consent_backlog_dropped_total', {
    description: 'Analytics events dropped when the per-instance SQL consent backlog is full',
  })

  constructor(
    private readonly db: DataSource,
    @InjectRedis() private readonly redis: Redis,
    config: TypedConfigService,
  ) {
    this.maxColdEvents = config.getOrThrow('posthog.consentBacklogLimit')
    const poolMax = db.options.extra?.max ?? db.options.poolSize ?? 10
    this.maxSqlReads = Math.max(0, Math.min(2, poolMax - 1))
  }

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

  private async subject(kind: Subject, id: string, admitCold: () => boolean): Promise<string> {
    const key = analyticsConsentCacheKey(kind, id)
    const cached = await sharedRead(this.cacheReads, key, () => this.redis.get(key))
    if (cached !== null) return cached
    if (!this.maxSqlReads || !admitCold()) return ''
    return sharedRead(this.databaseReads, key, () => this.readDatabase(kind, id, key))
  }

  private async readDatabase(kind: Subject, id: string, key: string): Promise<string> {
    if (this.activeSqlReads < this.maxSqlReads) this.activeSqlReads++
    else await new Promise<void>((resolve) => this.sqlWaiters.push(resolve))
    const expiresAt = Date.now() + ttlMs
    let value: string
    try {
      const sql =
        kind === 'creator'
          ? 'SELECT "createdBy" AS value FROM organization WHERE id = $1'
          : `SELECT ceil(extract(epoch FROM decided_at) * 1000)::bigint::text AS value
           FROM product_analytics_consent WHERE user_id = $1 AND allowed AND notice_version = $2`
      const [row]: { value: string }[] = await this.db.query(
        sql,
        kind === 'creator' ? [id] : [id, analyticsNoticeVersion],
      )
      value = row?.value ?? ''
    } finally {
      // Hand this slot to the next reader before doing any cache write or HTTP work.
      const next = this.sqlWaiters.shift()
      if (next) next()
      else this.activeSqlReads--
    }
    // Cache misses and denials, too. Slow reads must not extend a stale decision's lifetime.
    if (Date.now() >= expiresAt) return ''
    await this.redis.set(key, value, 'PXAT', expiresAt, 'NX')
    return value
  }

  async dispatch(subjects: AnalyticsSubjects, occurredAt: Date, send: () => Promise<void>): Promise<boolean> {
    const at = occurredAt.getTime()
    if (!Number.isFinite(at) || at > Date.now() || this.redis.status !== 'ready') return false
    let cold = false
    const admitCold = () => {
      if (cold) return true
      if (this.coldEvents >= this.maxColdEvents) {
        this.overflow.add(1)
        return false
      }
      this.coldEvents++
      cold = true
      return true
    }
    try {
      const users = new Set(subjects.users)
      for (const org of new Set(subjects.organizations)) {
        const creator = await this.subject('creator', org, admitCold)
        if (!creator) return false
        users.add(creator)
      }
      if (!users.size) return false
      for (const user of users) {
        const grant = await this.subject('grant', user, admitCold)
        if (!/^\d+$/.test(grant) || Number(grant) > at) return false
      }
    } finally {
      if (cold) this.coldEvents--
    }
    await send()
    return true
  }
}
