import { HttpException, Injectable } from '@nestjs/common'
import { InjectRedis } from '@nestjs-modules/ioredis'
import { createHash, randomUUID } from 'crypto'
import { Redis } from 'ioredis'
import { DataSource } from 'typeorm'
import { AuthContext } from '../../common/interfaces/auth-context.interface'
import { AdminUsageItemDto, AdminUsagePageDto } from '../dto/usage.dto'
import {
  usageCursor,
  usageCursorValue,
  usageError,
  UsageRequest,
  USAGE_DEFINITION,
  USAGE_MAX_BYTES,
  USAGE_MAX_ITEMS,
  USAGE_MAX_PERIODS,
  USAGE_TTL_SECONDS,
} from '../utils/usage-query'
import { usageAggregation } from './usage.sql'

type UsageSnapshot = { binding: string; page: Omit<AdminUsagePageDto, 'nextCursor'> }
type AggregateResult = { periodCount: number; invalid: boolean; items: AdminUsageItemDto[] }
const cacheKey = (id: string) => `admin-usage:${id}`
const decimal = (value: string): string => {
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw usageError(503)
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
}

@Injectable()
export class AdminUsageService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async query(request: UsageRequest, auth: AuthContext, owner?: string): Promise<AdminUsagePageDto> {
    const binding = createHash('sha256')
      .update(JSON.stringify([USAGE_DEFINITION, request.query, auth.userId, owner ?? null]))
      .digest('hex')
    try {
      let snapshot: UsageSnapshot
      let offset = 0
      if (request.cursor) {
        const cursor = usageCursorValue(request.cursor)
        const stored = await this.redis.get(cacheKey(cursor.queryId))
        if (stored === null) throw usageError(410)
        if (Buffer.byteLength(stored) > USAGE_MAX_BYTES) throw usageError(503)
        snapshot = JSON.parse(stored)
        if (
          typeof snapshot?.binding !== 'string' ||
          !/^[a-f0-9]{64}$/.test(snapshot.binding) ||
          !snapshot?.page ||
          !Array.isArray(snapshot.page.items) ||
          snapshot.page.queryId !== cursor.queryId ||
          snapshot.page.definitionVersion !== USAGE_DEFINITION ||
          !Number.isFinite(Date.parse(snapshot.page.expiresAt))
        )
          throw usageError(503)
        if (snapshot.binding !== binding) throw usageError(400)
        if (Date.parse(snapshot.page.expiresAt) <= Date.now()) throw usageError(410)
        offset = cursor.offset
        if (offset >= snapshot.page.items.length) throw usageError(400)
      } else {
        const generatedAt = new Date()
        const statement = usageAggregation(request.query)
        const [result]: AggregateResult[] = await this.dataSource.transaction(async (manager) => {
          await manager.query(`SET LOCAL statement_timeout = '5s'`)
          return manager.query(statement.sql, statement.parameters)
        })
        if (!result || result.invalid) throw usageError(503)
        if (result.periodCount > USAGE_MAX_PERIODS || result.items.length > USAGE_MAX_ITEMS) throw usageError(422)
        for (const item of result.items) {
          for (const metric of request.query.metrics) item.values[metric] = decimal(item.values[metric] as string)
        }
        snapshot = {
          binding,
          page: {
            queryId: randomUUID(),
            generatedAt: generatedAt.toISOString(),
            expiresAt: new Date(generatedAt.getTime() + USAGE_TTL_SECONDS * 1000).toISOString(),
            definitionVersion: USAGE_DEFINITION,
            query: request.query,
            coverage: { status: 'unknown', reason: 'usage_events_not_backfilled' },
            items: result.items,
          },
        }
        const stored = JSON.stringify(snapshot)
        if (Buffer.byteLength(stored) > USAGE_MAX_BYTES) throw usageError(422)
        const ttl = Date.parse(snapshot.page.expiresAt) - Date.now()
        if (ttl <= 0) throw usageError(503)
        if ((await this.redis.set(cacheKey(snapshot.page.queryId), stored, 'PX', ttl)) !== 'OK') throw usageError(503)
      }
      const end = offset + request.limit
      return {
        ...snapshot.page,
        items: snapshot.page.items.slice(offset, end),
        nextCursor: end < snapshot.page.items.length ? usageCursor(snapshot.page.queryId, end) : null,
      }
    } catch (error) {
      if (error instanceof HttpException) throw error
      throw usageError(503)
    }
  }
}
