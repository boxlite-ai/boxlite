/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { HttpException, HttpStatus, Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import type Redis from 'ioredis'
import { createHash, randomUUID } from 'node:crypto'

const RECORD_TTL_SECONDS = 24 * 60 * 60
export const REPLAY_COMMAND_TIMEOUT_MS = 1_000
export const REPLAY_HEARTBEAT_MS = 1_000
const COMPLETION_DEADLINE_MS = 5_000
export const REPLAY_MAX_RESPONSE_BYTES = 1024 * 1024

export interface ReplayResource {
  id: string
  organizationId: string
}
export interface ReplayResponse {
  status: number
  body: string
  encoding?: 'base64'
  headers?: Record<string, string>
  resource?: ReplayResource
  auditTargetId?: string
}
interface ReplayReservation {
  key: string
  owner: string
}
interface ReplayOptions {
  replayOnly?: boolean
}

/** Only the HTTP entry owns this handle. Unknown outcomes keep their fence; late success may still complete. */
export class ReplaySession {
  constructor(
    readonly response: ReplayResponse | undefined,
    private readonly reservation: ReplayReservation | undefined,
    private readonly redis: Redis | undefined,
  ) {}

  get isOwner(): boolean {
    return this.reservation !== undefined
  }

  async complete(response: ReplayResponse): Promise<void> {
    if (!this.reservation || !this.redis) return
    const serialized = JSON.stringify(response)
    if (Buffer.byteLength(serialized) > REPLAY_MAX_RESPONSE_BYTES) {
      await this.markUnknown()
      return
    }
    await this.redis.eval(COMPLETE_SCRIPT, 1, this.reservation.key, this.reservation.owner, serialized)
  }

  async markRetryable(): Promise<void> {
    await this.update('retryable')
  }
  async markUnknown(): Promise<void> {
    await this.update('unknown')
  }
  async heartbeat(): Promise<void> {
    await this.update('heartbeat')
  }

  private async update(state: string): Promise<void> {
    if (!this.reservation || !this.redis) return
    await this.redis.eval(UPDATE_SCRIPT, 1, this.reservation.key, this.reservation.owner, state)
  }
}

// Redis time and absolute expiry are shared by replicas. Neither heartbeat nor reclaim extends retention.
const RESERVE_SCRIPT = `
local fp = redis.call('HGET', KEYS[1], 'fingerprint')
if redis.call('EXISTS', KEYS[1]) == 0 then
  if ARGV[4] == 'peek' or ARGV[4] == 'replay-only' then return {'unknown'} end
  local now = redis.call('TIME')
  local now_ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
  redis.call('HSET', KEYS[1], 'fingerprint', ARGV[1], 'owner', ARGV[2],
    'state', 'pending', 'expected_response_at', tostring(now_ms + ${COMPLETION_DEADLINE_MS}))
  local ok = redis.pcall('EXPIRE', KEYS[1], ARGV[3])
  if type(ok) == 'table' and ok.err then
    redis.call('DEL', KEYS[1])
    return redis.error_reply('idempotency: failed to set retention')
  end
  return {'owner'}
end
if fp ~= ARGV[1] then return {'mismatch'} end
local body = redis.call('HGET', KEYS[1], 'response')
if body then return {'replay', body} end
if ARGV[4] == 'peek' or ARGV[4] == 'replay-only' then return {'unknown'} end
local state = redis.call('HGET', KEYS[1], 'state')
local now = redis.call('TIME')
local now_ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
if state == 'retryable' then
  redis.call('HSET', KEYS[1], 'owner', ARGV[2], 'state', 'pending', 'reclaimed', '1',
    'expected_response_at', tostring(now_ms + ${COMPLETION_DEADLINE_MS}))
  return {'owner'}
end
if state == 'unknown' then return {'unknown'} end
local deadline = tonumber(redis.call('HGET', KEYS[1], 'expected_response_at') or '0')
if now_ms >= deadline then return {'unknown'} end
return {'pending'}
`
const COMPLETE_SCRIPT = `
if redis.call('HGET', KEYS[1], 'owner') ~= ARGV[1] then return 0 end
local state = redis.call('HGET', KEYS[1], 'state')
if state and state ~= 'pending' and state ~= 'unknown' then return 0 end
if redis.call('HEXISTS', KEYS[1], 'response') == 1 then return 0 end
redis.call('HSET', KEYS[1], 'response', ARGV[2], 'state', 'complete')
return 1
`
const UPDATE_SCRIPT = `
if redis.call('HGET', KEYS[1], 'owner') ~= ARGV[1] then return 0 end
if redis.call('HEXISTS', KEYS[1], 'response') == 1 then return 0 end
if ARGV[2] == 'heartbeat' then
  if redis.call('HGET', KEYS[1], 'state') ~= 'pending' then return 0 end
  local now = redis.call('TIME')
  local now_ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
  redis.call('HSET', KEYS[1], 'expected_response_at', tostring(now_ms + ${COMPLETION_DEADLINE_MS}))
else
  redis.call('HSET', KEYS[1], 'state', ARGV[2])
  if ARGV[2] == 'retryable' then redis.call('HDEL', KEYS[1], 'owner') end
end
return 1
`
const RELEASE_IF_OWNER_SCRIPT = `
if redis.call('HGET', KEYS[1], 'owner') ~= ARGV[1] then return 0 end
if redis.call('HEXISTS', KEYS[1], 'response') == 1 then return 0 end
if redis.call('HEXISTS', KEYS[1], 'reclaimed') == 0 then return redis.call('DEL', KEYS[1]) end
redis.call('HSET', KEYS[1], 'state', 'retryable')
redis.call('HDEL', KEYS[1], 'owner')
return 1
`

function recordKey(organizationId: string, subjectId: string, operation: string, requestId: string): string {
  return `replay:${organizationId}:${subjectId}:${operation}:${createHash('sha256').update(requestId).digest('hex')}`
}

function storedResponse(raw: string): ReplayResponse | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || !('status' in value) || !('body' in value)) return undefined
    if (typeof value.status !== 'number' || value.status < 200 || value.status >= 300 || typeof value.body !== 'string')
      return undefined
    if ('encoding' in value && value.encoding !== 'base64') return undefined
    if (
      'headers' in value &&
      (!value.headers ||
        typeof value.headers !== 'object' ||
        Object.entries(value.headers).some(
          ([key, item]) => !['content-type', 'location'].includes(key) || typeof item !== 'string',
        ))
    )
      return undefined
    if (
      'resource' in value &&
      (!value.resource ||
        typeof value.resource !== 'object' ||
        !('id' in value.resource) ||
        !('organizationId' in value.resource) ||
        typeof value.resource.id !== 'string' ||
        typeof value.resource.organizationId !== 'string')
    )
      return undefined
    if ('auditTargetId' in value && typeof value.auditTargetId !== 'string') return undefined
    // Every optional field was validated above; this is the persisted response boundary.
    return value as ReplayResponse
  } catch {
    return undefined
  }
}

@Injectable()
export class BoxRequestReplayService implements OnModuleDestroy {
  private readonly logger = new Logger(BoxRequestReplayService.name)
  private connection?: Redis
  private connecting?: Promise<Redis>
  private policyChecked = false
  private readonly noOpSession = new ReplaySession(undefined, undefined, undefined)

  constructor(@Inject(getRedisConnectionToken()) private readonly redis: Redis) {}

  onModuleDestroy(): void {
    this.connection?.disconnect()
  }

  async session(
    organizationId: string,
    subjectId: string,
    operation: string,
    requestId: string | undefined,
    fingerprint: string,
    options: ReplayOptions = {},
  ): Promise<ReplaySession> {
    if (!requestId) return this.noOpSession
    const key = recordKey(organizationId, subjectId, operation, requestId)
    const owner = randomUUID()
    const { result, connection } = await this.reserve(
      key,
      owner,
      fingerprint,
      options.replayOnly ? 'replay-only' : 'reserve',
    )
    if (result[0] === 'owner') return new ReplaySession(undefined, { key, owner }, connection)
    if (result[0] === 'replay') {
      const response = storedResponse(result[1])
      if (response) return new ReplaySession(response, undefined, undefined)
      this.logger.warn(`Corrupt replay record for ${operation}; retaining fence`)
    }
    if (result[0] === 'mismatch')
      throw new HttpException(
        { message: 'Idempotency-Key was already used with a different request', code: 'idempotency_payload_mismatch' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    if (result[0] === 'pending')
      throw new HttpException(
        {
          message: 'The original request is still processing. Retry with the same Idempotency-Key.',
          code: 'idempotency_in_progress',
        },
        HttpStatus.CONFLICT,
      )
    throw new HttpException(
      {
        message:
          'The original request has no recorded response and its outcome is unknown. This request was not executed again.',
        code: 'idempotency_outcome_unknown',
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    )
  }

  async peekCompleted(
    organizationId: string,
    subjectId: string,
    operation: string,
    requestId: string,
    fingerprint: string,
  ): Promise<ReplayResponse | undefined> {
    const { result } = await this.reserve(
      recordKey(organizationId, subjectId, operation, requestId),
      '',
      fingerprint,
      'peek',
    )
    return result[0] === 'replay' ? storedResponse(result[1]) : undefined
  }

  private async reserve(
    key: string,
    owner: string,
    fingerprint: string,
    mode: 'reserve' | 'replay-only' | 'peek',
  ): Promise<{ result: string[]; connection: Redis }> {
    let timer: NodeJS.Timeout | undefined
    let abandoned = false
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abandoned = true
        reject(new Error('Replay reservation deadline exceeded'))
      }, REPLAY_COMMAND_TIMEOUT_MS)
    })
    const claim = async () => {
      const connection = await this.ready()
      if (abandoned) throw new Error('Replay reservation deadline exceeded')
      try {
        const result = await connection.eval(RESERVE_SCRIPT, 1, key, fingerprint, owner, RECORD_TTL_SECONDS, mode)
        if (abandoned) throw new Error('Replay reservation deadline exceeded')
        if (!Array.isArray(result) || result.some((item) => typeof item !== 'string'))
          throw new Error('Invalid replay storage result')
        return { result: result as string[], connection }
      } catch (error) {
        if (mode === 'reserve') {
          // An ioredis timeout rejects the promise, but Redis can still execute EVAL.
          // Queue owner-checked cleanup behind the claim on the same connection.
          void connection.eval(RELEASE_IF_OWNER_SCRIPT, 1, key, owner).catch(() => {
            this.logger.warn('Failed to release an undispatched replay reservation')
          })
        }
        throw error
      }
    }
    try {
      return await Promise.race([claim(), deadline])
    } catch (error) {
      throw this.unavailable(error)
    } finally {
      clearTimeout(timer)
    }
  }

  private async ready(): Promise<Redis> {
    if (this.connecting) return this.connecting
    if (this.policyChecked && this.connection?.status === 'ready') return this.connection
    if (!this.connection) {
      this.connection = this.redis.duplicate({
        lazyConnect: true,
        commandTimeout: REPLAY_COMMAND_TIMEOUT_MS,
        connectTimeout: REPLAY_COMMAND_TIMEOUT_MS,
        maxRetriesPerRequest: 0,
        enableOfflineQueue: false,
        autoResendUnfulfilledCommands: false,
        retryStrategy: null,
      })
      this.connection.on('error', () => undefined)
    }
    const connection = this.connection
    this.connecting = (async () => {
      try {
        if (connection.status === 'wait' || connection.status === 'end') await connection.connect()
        const memory = await connection.info('memory')
        if (!/^maxmemory_policy:noeviction\r?$/m.test(memory))
          throw new Error('Replay Redis requires maxmemory-policy=noeviction')
        this.policyChecked = true
        return connection
      } catch (error) {
        this.policyChecked = false
        throw this.unavailable(error)
      } finally {
        this.connecting = undefined
      }
    })()
    return this.connecting
  }

  private unavailable(error: unknown): HttpException {
    this.logger.warn('Replay storage unavailable; request not dispatched')
    return new HttpException(
      { message: 'Request replay storage is unavailable', code: 'idempotency_storage_unavailable' },
      HttpStatus.SERVICE_UNAVAILABLE,
      { cause: error },
    )
  }
}
