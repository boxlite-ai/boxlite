/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { BadRequestException, Injectable } from '@nestjs/common'
import { isUUID } from 'class-validator'
import { createHash } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import type { Request } from 'express'
import { routeShape } from '../mcp/mcp-routes'

export const REPLAY_LIFETIME = 'PT24H'
export const REPLAY_ONLY = Symbol('replay-only')
export const REPLAY_RESOURCE = Symbol('replay-resource')
const WRITES: Record<string, true> = { POST: true, PUT: true, PATCH: true, DELETE: true }

function canonicalRoute(path: string): string {
  return path.replace(/\/(?:\:prefix|\{prefix\})(?=\/)/, '').replace(/\/$/, '')
}

export function replayPolicy(
  method: string,
  path: string,
  webSocket = false,
): 'supported' | 'excluded' | 'outside' | 'read' {
  const route = canonicalRoute(path).split('?')[0]
  if (!/^\/(?:api\/)?v1(?:\/|$)/.test(route)) return 'outside'
  if (/\/v1\/organizations(?:\/|$)/.test(route)) return 'outside'
  if (webSocket || /\/attach(?:\/|$)/.test(route)) return 'excluded'
  if (/\/files(?:\/|$)/.test(route) || (method.toUpperCase() === 'POST' && /\/network\/tunnel$/.test(route)))
    return 'excluded'
  if (!WRITES[method.toUpperCase()]) return 'read'
  return 'supported'
}

export function validateReplayKey(req: Pick<Request, 'headers' | 'rawHeaders'>): string | undefined {
  const raw = req.rawHeaders ?? []
  let count = 0
  for (let index = 0; index < raw.length; index += 2) if (raw[index].toLowerCase() === 'idempotency-key') count++
  const key = req.headers['idempotency-key']
  if (key === undefined && count === 0) return undefined
  if (count > 1 || typeof key !== 'string' || !isUUID(key))
    throw new BadRequestException('Idempotency-Key must be a single UUID')
  return key
}

/** Called before a stream or upgrade can reach its business handler. */
export function assertReplaySupported(method: string, path: string, headers: IncomingHttpHeaders): void {
  if (
    headers['idempotency-key'] !== undefined &&
    replayPolicy(method, path, /\/attach(?:\?|$)/.test(path)) === 'excluded'
  ) {
    throw new BadRequestException('Idempotency-Key is not supported for this operation')
  }
}

function stable(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function replayIdentity(req: Request): { operation: string; fingerprint: string } {
  const route = canonicalRoute(String(req.route?.path ?? req.path))
  const method = req.method.toUpperCase()
  const shape = routeShape(route)
  const operation =
    method === 'POST' && shape === '/api/v1/boxes'
      ? 'createBox'
      : method === 'POST' && shape === '/api/v1/boxes/*/exec'
        ? 'startExecution'
        : `${method} ${shape}`
  const params = Object.fromEntries(Object.entries(req.params ?? {}).filter(([key]) => key !== 'prefix'))
  const fingerprint = `v2:${createHash('sha256')
    .update(stable([method, params, req.query, req.body]))
    .digest('hex')}`
  return { operation, fingerprint }
}

/** Discovery describes registered routes; it never decides whether a new write is protected. */
@Injectable()
export class RequestReplayPolicy {
  private supportedOperations: string[] = []

  configure(expressApp: unknown, document: { paths?: object }): void {
    // Express exposes its registered router layers without a public structural type.
    const app = expressApp as {
      router?: { stack?: { route?: { path: string | string[]; methods: Record<string, boolean> } }[] }
    }
    const layers = app.router?.stack ?? []
    const routes = new Set<string>()
    for (const { route } of layers) {
      if (!route) continue
      for (const path of [route.path].flat())
        for (const [method, enabled] of Object.entries(route.methods)) {
          if (enabled)
            routes.add(`${method === '_all' ? '*' : method.toUpperCase()} ${routeShape(canonicalRoute(path))}`)
        }
    }
    const ids = new Set<string>()
    for (const [path, item] of Object.entries(document.paths ?? {})) {
      const route = `/api/v1${canonicalRoute(path)}`
      for (const [method, operation] of Object.entries(item as object)) {
        if (!this.supports(method, route)) continue
        const shape = routeShape(route)
        if (!routes.has(`${method.toUpperCase()} ${shape}`) && !routes.has(`* ${shape}`)) continue
        const id =
          operation && typeof operation === 'object' && 'operationId' in operation ? operation.operationId : undefined
        if (typeof id !== 'string' || !id) throw new Error(`Missing operationId for replay operation ${method} ${path}`)
        ids.add(id)
      }
    }
    this.supportedOperations = [...ids].sort()
  }

  supports(method: string, path: string, webSocket = false): boolean {
    return replayPolicy(method, path, webSocket) === 'supported'
  }
  operations(): string[] {
    return [...this.supportedOperations]
  }
}
