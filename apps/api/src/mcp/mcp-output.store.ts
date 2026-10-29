/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { InjectRedis } from '@nestjs-modules/ioredis'
import { Injectable } from '@nestjs/common'
import { Redis } from 'ioredis'
import { McpOperation } from './mcp-operation.store'

type Chunk = { cursor: number; stream: 'stdout' | 'stderr'; text: string; segment: number }
type Lease = Pick<McpOperation, 'id' | 'organization_id' | 'lease_epoch'>
const OUTPUT_BYTES = 512 * 1024
const OUTPUT_TTL = 3600

// The metadata and chunks share a cluster hash tag. Every write verifies both
// the Postgres lease epoch and its conservative local expiry.
const WRITE = `
if redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
local epoch = tonumber(redis.call('HGET', KEYS[1], 'epoch') or '-1')
local incoming = tonumber(ARGV[1])
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + tonumber(clock[2]) / 1000
if ARGV[2] == 'lease' then
  if incoming < epoch or (epoch == -1 and ARGV[4] ~= 'initial') then return 0 end
  if incoming > epoch then
    redis.call('HINCRBY', KEYS[1], 'segment', 1)
    if epoch >= 0 then redis.call('HSET', KEYS[1], 'uncertain', '1') end
  end
  redis.call('HSET', KEYS[1], 'epoch', incoming, 'until', ARGV[3])
elseif incoming ~= epoch or tonumber(redis.call('HGET', KEYS[1], 'until') or '0') <= now then
  return 0
elseif ARGV[2] == 'append' then
  local seq = redis.call('HINCRBY', KEYS[1], 'seq', 1)
  local segment = tonumber(redis.call('HGET', KEYS[1], 'segment'))
  local chunk = cjson.encode({cursor=seq, stream=ARGV[3], text=ARGV[4], segment=segment})
  redis.call('RPUSH', KEYS[2], chunk)
  local bytes = redis.call('HINCRBY', KEYS[1], 'bytes', string.len(chunk))
  while bytes > tonumber(ARGV[5]) or redis.call('LLEN', KEYS[2]) > 1024 do
    local removed = redis.call('LPOP', KEYS[2])
    bytes = redis.call('HINCRBY', KEYS[1], 'bytes', -string.len(removed))
    redis.call('HSET', KEYS[1], 'truncated', '1')
  end
  if ARGV[6] == '1' then redis.call('HSET', KEYS[1], 'replacement', '1') end
elseif ARGV[2] == 'finish' then
  redis.call('HSET', KEYS[1], 'finished', '1')
end
redis.call('EXPIRE', KEYS[1], ARGV[7])
redis.call('EXPIRE', KEYS[2], ARGV[7])
return 1`

@Injectable()
export class McpOutputStore {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  async lease(operation: Lease, expiresAt: number, initial = false): Promise<void> {
    await this.write(operation, 'lease', String(expiresAt), initial ? 'initial' : '')
  }

  async append(operation: Lease, stream: Chunk['stream'], text: string): Promise<void> {
    // Code-point splitting preserves surrogate pairs; StringDecoder in the
    // collector handles UTF-8 split across runner frames.
    const points = Array.from(text)
    for (let i = 0; i < points.length; i += 512) {
      const part = points.slice(i, i + 512).join('')
      await this.write(operation, 'append', stream, part, part.includes('\uFFFD'))
    }
  }

  async finish(operation: Lease): Promise<void> {
    await this.write(operation, 'finish')
  }

  async read(operation: McpOperation, cursor: number) {
    const [metadata, key] = this.keys(operation)
    const result = await this.redis.multi().hgetall(metadata).lrange(key, 0, -1).exec()
    if (!result || result.some(([error]) => error)) throw new Error('MCP output storage unavailable')
    const meta = result[0][1] as Record<string, string>
    if (!meta.epoch)
      return {
        output_status:
          operation.completed_at && Date.now() - operation.completed_at.getTime() >= OUTPUT_TTL * 1000
            ? 'expired'
            : 'unavailable',
        output_complete: null,
      }
    const all = (result[1][1] as string[]).map((value) => JSON.parse(value) as Chunk)
    const chunks: Chunk[] = []
    let bytes = 0
    for (const chunk of all.filter((item) => item.cursor > cursor)) {
      const size = Buffer.byteLength(JSON.stringify(chunk))
      // MCP returns both structured data and JSON text; reserve space for both.
      if (bytes + size > 5 * 1024) break
      chunks.push(chunk)
      bytes += size
    }
    const lost = all.length > 0 && cursor < all[0].cursor - 1
    return {
      output_status: 'available',
      chunks,
      next_cursor: chunks.at(-1)?.cursor ?? cursor,
      output_complete: meta.truncated || meta.replacement ? false : null,
      truncated: meta.truncated === '1',
      cursor_lost: lost,
      utf8_replacement: meta.replacement === '1',
      uncertain_segments: meta.uncertain === '1',
      runner_lag: null,
      output_expires_at: operation.completed_at
        ? new Date(operation.completed_at.getTime() + OUTPUT_TTL * 1000).toISOString()
        : null,
    }
  }

  async purgeOrganization(organizationId: string): Promise<void> {
    const prefix = `mcp:output:{${organizationId}}:`
    // Tombstone fences collectors on other replicas before keys are removed.
    await this.redis.set(`${prefix}deleted`, '1', 'EX', 25 * 3600)
    let cursor = '0'
    do {
      const page = await this.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100)
      cursor = page[0]
      const keys = page[1].filter((key) => key !== `${prefix}deleted`)
      if (keys.length) await this.redis.del(...keys)
    } while (cursor !== '0')
  }

  private keys(operation: Pick<McpOperation, 'id' | 'organization_id'>): [string, string, string] {
    const prefix = `mcp:output:{${operation.organization_id}}:`
    return [`${prefix}${operation.id}:meta`, `${prefix}${operation.id}:chunks`, `${prefix}deleted`]
  }

  private async write(operation: Lease, action: string, arg = '', value = '', replacement = false): Promise<void> {
    const result = await this.redis.eval(
      WRITE,
      3,
      ...this.keys(operation),
      operation.lease_epoch,
      action,
      arg,
      value,
      OUTPUT_BYTES,
      replacement ? '1' : '0',
      OUTPUT_TTL,
    )
    if (result !== 1) throw new Error('MCP output lease lost')
  }
}
