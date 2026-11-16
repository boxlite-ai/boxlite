/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException, HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import type Redis from 'ioredis'
import { createHash, randomUUID } from 'node:crypto'

/**
 * How long a request record lives after its first use. Matches the public
 * contract: "Keys expire after the duration advertised in GET /v1/config"
 * (openapi/box.openapi.yaml idempotencyKey). Retries never extend this.
 */
const RECORD_TTL_SECONDS = 24 * 60 * 60

/**
 * How long a pending owner has to record its outcome before the next caller
 * treats the result as unknown. Bounds the window where a crashed replica
 * leaves a key permanently uncallable.
 */
const COMPLETION_DEADLINE_MS = 5_000

/**
 * A stored success response replayed to the retrying caller. The status code
 * is preserved alongside the body so the caller sees the original contract.
 */
export interface ReplayResponse {
  status: number
  body: string
}

/**
 * Fencing handle proving this caller won the key; a stale owner cannot
 * overwrite a record that a newer caller has reclaimed.
 */
interface ReplayReservation {
  key: string
  owner: string
}

/**
 * A replay session the controller drives through the business call. Without
 * a key, `response` is undefined and `complete`/`releaseSafe` are no-ops;
 * with a key won by this caller, the controller must call exactly one of
 * `complete` (on success) or `releaseSafe` (on a proven pre-dispatch failure).
 */
export class ReplaySession {
  constructor(
    readonly response: ReplayResponse | undefined,
    private readonly reservation: ReplayReservation | undefined,
    private readonly redis: Redis | undefined,
  ) {}

  get isOwner(): boolean {
    return this.reservation !== undefined
  }

  /** Persists the original status and JSON body for same-key retries. */
  async complete(response: ReplayResponse): Promise<void> {
    if (!this.reservation || !this.redis) return
    await this.redis.eval(
      COMPLETE_SCRIPT,
      1,
      this.reservation.key,
      this.reservation.owner,
      JSON.stringify(response),
      'complete',
    )
  }

  /**
   * Marks a proven pre-dispatch failure (quota rejection) as safe to retry,
   * so a same-key caller can reclaim the slot after capacity is freed.
   * Non-retryable failures release the pending record entirely.
   */
  async releaseSafe(retryable: boolean): Promise<void> {
    if (!this.reservation || !this.redis) return
    await this.redis.eval(RELEASE_SCRIPT, 1, this.reservation.key, this.reservation.owner, retryable ? '1' : '0')
  }
}

/**
 * Atomic per-key state shared by every API instance. Each hash holds the
 * request fingerprint, the current owner, and (once set) the original
 * response. The Lua scripts make EXISTS → HSET → EXPIRE one operation, so
 * two replicas cannot both win the same key; the completion script rejects
 * a stale owner writing after its reservation expired and was reclaimed.
 */
const RESERVE_SCRIPT = `
local now = redis.call('TIME')
local now_ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('HSET', KEYS[1],
    'fingerprint', ARGV[1],
    'owner', ARGV[2],
    'expected_response_at', tostring(now_ms + ${COMPLETION_DEADLINE_MS}))
  local ok = redis.pcall('EXPIRE', KEYS[1], ARGV[3])
  if type(ok) == 'table' and ok.err then
    redis.call('DEL', KEYS[1])
    return redis.error_reply('idempotency: failed to set retention')
  end
  return {'owner'}
end
local fp = redis.call('HGET', KEYS[1], 'fingerprint')
local body = redis.call('HGET', KEYS[1], 'response')
local state = redis.call('HGET', KEYS[1], 'state')
if fp ~= ARGV[1] then return {'mismatch'} end
if body then return {'replay', body} end
if state == 'retryable' then
  redis.call('HSET', KEYS[1], 'owner', ARGV[2], 'state', 'pending',
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
if state and state ~= 'pending' then return 0 end
redis.call('HSET', KEYS[1], 'response', ARGV[2], 'state', ARGV[3])
return 1
`

/**
 * Releases a reservation the owner never used: a safe failure (quota
 * rejection) marks the record retryable so the same key can reclaim it;
 * anything else deletes a still-pending record that has no response.
 * A completed record is always kept.
 */
const RELEASE_SCRIPT = `
if redis.call('HGET', KEYS[1], 'owner') ~= ARGV[1] then return 0 end
if redis.call('HEXISTS', KEYS[1], 'response') == 1 then return 0 end
if ARGV[2] == '1' then
  redis.call('HSET', KEYS[1], 'state', 'retryable')
  redis.call('HDEL', KEYS[1], 'owner')
  return 1
end
redis.call('DEL', KEYS[1])
return 1
`

/**
 * Stable per-record key. The SHA-256 of the UUID prevents unbounded key
 * growth from direct injection; the scoping fields isolate tenants.
 */
function recordKey(organizationId: string, subjectId: string, operation: string, requestId: string): string {
  const digest = createHash('sha256').update(requestId).digest('hex')
  return `replay:${organizationId}:${subjectId}:${operation}:${digest}`
}

/**
 * Request fingerprint binding the key to one operation's inputs. Every field
 * that could change the business result must participate: method, resolved
 * path, and the parsed request body. The serialization must be stable for
 * identical logical requests across replicas.
 */
export function fingerprintOf(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method}\n${path}\n${JSON.stringify(body ?? null)}`)
    .digest('hex')
}

@Injectable()
export class BoxRequestReplayService {
  private readonly logger = new Logger(BoxRequestReplayService.name)
  private readonly noOpSession = new ReplaySession(undefined, undefined, undefined)

  constructor(@Inject(getRedisConnectionToken()) private readonly redis: Redis) {}

  /**
   * Atomically claims a key and returns a replay session for the controller
   * to drive through its business call. Without a key, a passthrough session
   * is returned. A key seen with different parameters is a documented 422;
   * pending and unknown block redispatch.
   *
   * Fingerprint must describe every input that affects the outcome: method,
   * resolved path, and the validated request body.
   */
  async session(
    organizationId: string,
    subjectId: string,
    operation: string,
    requestId: string | undefined,
    fingerprint: string,
  ): Promise<ReplaySession> {
    if (!requestId) return this.noOpSession

    const key = recordKey(organizationId, subjectId, operation, requestId)
    const owner = randomUUID()
    const result = (await this.redis.eval(RESERVE_SCRIPT, 1, key, fingerprint, owner, RECORD_TTL_SECONDS)) as string[]

    switch (result[0]) {
      case 'owner':
        return new ReplaySession(undefined, { key, owner }, this.redis)
      case 'replay': {
        try {
          const stored = JSON.parse(result[1]) as ReplayResponse
          return new ReplaySession(stored, undefined, undefined)
        } catch {
          this.logger.warn(`Corrupt replay record for ${operation}; treating as unknown`)
          throw this.unknownResult()
        }
      }
      case 'mismatch':
        throw new HttpException(
          {
            message: 'Idempotency-Key was already used with a different request',
            code: 'idempotency_payload_mismatch',
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      case 'pending':
        throw new ConflictException(
          'The original request has not recorded a response yet. Retry with the same Idempotency-Key.',
        )
      default:
        throw this.unknownResult()
    }
  }

  private unknownResult(): HttpException {
    return new HttpException(
      {
        message:
          'The original request has no recorded response and its outcome is unknown. This request was not executed again.',
        code: 'idempotency_outcome_unknown',
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    )
  }
}
