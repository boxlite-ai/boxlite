/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { DbStatementSerializer, defaultDbStatementSerializer } from '@opentelemetry/redis-common'

/** Never include query strings, credentials, output, or headers in MCP telemetry. */
export function mcpRequestPath(url: string | undefined): string | undefined {
  if (!url) return undefined
  let path: string
  try {
    path = decodeURIComponent(new URL(url, 'http://localhost').pathname)
  } catch {
    return '/mcp/invalid-url'
  }
  return /^\/(?:api\/mcp(?:-consent)?|mcp)(?:\/|$)/i.test(path) ? path : undefined
}

// pino-http passes its standard serialized objects to these wrappers.
export const mcpHttpSerializers = {
  req: (request: { id?: unknown; method?: string; url?: string }) => {
    const path = mcpRequestPath(request.url)
    return path ? { id: request.id, method: request.method, url: path } : request
  },
  res: (response: { statusCode?: number; raw?: { req?: { originalUrl?: string; url?: string } } }) => {
    const request = response.raw?.req
    return mcpRequestPath(request?.originalUrl ?? request?.url) ? { statusCode: response.statusCode } : response
  },
}

// The upstream serializer logs every EVAL argument, including our output text.
export const mcpRedisStatement: DbStatementSerializer = (command, args) =>
  args.some((arg) => (typeof arg === 'string' || Buffer.isBuffer(arg)) && arg.toString().startsWith('mcp:output:'))
    ? `${command} [MCP output omitted]`
    : defaultDbStatementSerializer(command, args)
