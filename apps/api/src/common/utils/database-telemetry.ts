/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (c) 2026 BoxLite AI
 */

import { Injectable, OnModuleInit } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { context, metrics } from '@opentelemetry/api'
import { DataSource } from 'typeorm'
import { QueryResultCache } from 'typeorm/cache/QueryResultCache'
import { QueryResultCacheOptions } from 'typeorm/cache/QueryResultCacheOptions'
import { startTimedOperation } from '../decorators/otel.decorator'

type PostgresPool = {
  totalCount: number
  idleCount: number
  waitingCount: number
  connect: (...args: any[]) => unknown
}

function queryCacheName(options: QueryResultCacheOptions): string {
  const key = options.identifier
  if (key?.startsWith('region:30s:')) return 'region_30s'
  if (key?.startsWith('region:60s:')) return 'region_60s'
  if (key?.startsWith('runner:lookup:')) return 'runner_lookup'
  if (key?.startsWith('runner:proxy-target:')) return 'runner_proxy_target'
  return 'other'
}

@Injectable()
export class DatabaseTelemetry implements OnModuleInit {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  onModuleInit(): void {
    this.instrumentPool()
    this.instrumentQueryCache()
  }

  private instrumentPool(): void {
    if (this.dataSource.options.type !== 'postgres') return
    const pool = (this.dataSource.driver as unknown as { master?: PostgresPool }).master
    if (!pool) return

    const meter = metrics.getMeter('')
    const gauge = (name: string, read: () => number) => {
      meter.createObservableGauge(name).addCallback((observation) => observation.observe(read()))
    }
    gauge('db_pool_connections_total', () => pool.totalCount)
    gauge('db_pool_connections_idle', () => pool.idleCount)
    gauge('db_pool_requests_waiting', () => pool.waitingCount)

    const waitDuration = meter.createHistogram('db_pool_connection_wait_duration', { unit: 'ms' })
    const connect = pool.connect.bind(pool)
    pool.connect = (...args: any[]) => {
      const startedAt = performance.now()
      const record = (status: 'success' | 'error') =>
        waitDuration.record(performance.now() - startedAt, { status })
      const callback = args[0]
      if (typeof callback === 'function') {
        return connect((error: unknown, ...rest: unknown[]) => {
          record(error ? 'error' : 'success')
          callback(error, ...rest)
        })
      }
      try {
        const result = connect(...args)
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          return (result as Promise<unknown>).then(
            (value) => {
              record('success')
              return value
            },
            (error) => {
              record('error')
              throw error
            },
          )
        }
        record('success')
        return result
      } catch (error) {
        record('error')
        throw error
      }
    }
  }

  private instrumentQueryCache(): void {
    const cache = this.dataSource.queryResultCache as QueryResultCache | undefined
    if (!cache) return

    const read = cache.getFromCache.bind(cache)
    cache.getFromCache = async (...args: Parameters<QueryResultCache['getFromCache']>) => {
      const operation = startTimedOperation('typeorm.query_cache_read', {
        'cache.system': 'typeorm',
        'cache.name': queryCacheName(args[0]),
      })
      try {
        const cached = await context.with(operation.ctx, () => read(...args))
        const result = cached === undefined ? 'miss' : cache.isExpired(cached) ? 'stale' : 'hit'
        operation.finish('success', undefined, { 'cache.result': result })
        return cached
      } catch (error) {
        operation.finish('error', error)
        throw error
      }
    }
  }
}
