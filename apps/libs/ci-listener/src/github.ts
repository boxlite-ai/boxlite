/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { KeyLike, sign } from 'node:crypto'
import { Json } from './state/database'

/** Short-lived GitHub App identity; key loading and rotation belong to the host. */
export function createGitHubAppJwt(issuer: string, key: KeyLike, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000)
  const unsigned =
    Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url') +
    '.' +
    Buffer.from(JSON.stringify({ iss: issuer, iat: now - 60, exp: now + 300 })).toString('base64url')
  return unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')
}

export class GitHubRequestError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly uncertain: boolean,
    readonly retryAt?: number,
  ) {
    super('GitHub request failed')
  }
}
interface GitHubRequest {
  url: string
  token?: string
  oauthApp?: { clientId: string; clientSecret: string }
  json?: Json
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  response?: 'json' | 'empty' | 'page'
  signal?: AbortSignal
}

/** Fixed GitHub origins, bounded JSON and sanitized errors; callers own retries and durable effect intents. */
export async function githubRequest(options: GitHubRequest): Promise<unknown> {
  const method = options.method ?? (options.json === undefined ? 'GET' : 'POST')
  let status: number | undefined,
    retryAt: number | undefined,
    attempted = false
  try {
    const address = new URL(options.url)
    const api = address.origin === 'https://api.github.com'
    const device =
      address.origin === 'https://github.com' &&
      ['/login/device/code', '/login/oauth/access_token'].includes(address.pathname)
    if (
      (!api && !device) ||
      address.username ||
      address.password ||
      address.hash ||
      (device && (options.token || options.oauthApp || method !== 'POST')) ||
      (options.oauthApp && (!api || method !== 'GET' || !!options.token)) ||
      (options.response === 'page' && (!api || method !== 'GET'))
    )
      throw new Error('Invalid GitHub endpoint')
    attempted = true
    const response = await fetch(options.url, {
      method,
      redirect: 'error',
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(options.oauthApp
          ? {
              Authorization:
                'Basic ' +
                Buffer.from(options.oauthApp.clientId + ':' + options.oauthApp.clientSecret).toString('base64'),
            }
          : options.token
            ? { Authorization: `Bearer ${options.token}` }
            : {}),
      },
      body: options.json === undefined ? undefined : JSON.stringify(options.json),
    })
    status = response.status
    if (status === 403 || status === 429) {
      const after = response.headers.get('retry-after'),
        reset = response.headers.get('x-ratelimit-reset')
      if (after && /^\d{1,10}$/.test(after)) retryAt = Date.now() + Number(after) * 1000
      if (response.headers.get('x-ratelimit-remaining') === '0' && reset && /^\d{1,12}$/.test(reset))
        retryAt = Math.max(retryAt ?? 0, Number(reset) * 1000)
      if (status === 429 && retryAt === undefined) retryAt = Date.now() + 60000
    }
    if (!response.ok || options.response === 'empty') {
      await response.body?.cancel()
      if (!response.ok) throw new Error('GitHub HTTP failure')
      return undefined
    }
    const link = response.headers.get('link')
    if (options.response === 'page' && link && Buffer.byteLength(link) > 8192) {
      await response.body?.cancel()
      throw new Error('GitHub pagination header limit')
    }
    if (!response.body) throw new Error('Missing GitHub JSON response')
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > 1_048_576) {
          await reader.cancel()
          throw new Error('GitHub response limit')
        }
        chunks.push(chunk.value)
      }
    } finally {
      reader.releaseLock()
    }
    const text = Buffer.concat(chunks).toString('utf8')
    if (options.response !== 'page') return JSON.parse(text)
    // Decimal IDs may change under Number#toString even when their binary value is exact.
    const data: unknown = JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
      typeof value === 'number' && !Number.isSafeInteger(value) && /^[1-9][0-9]*$/.test(context?.source ?? '')
        ? context!.source
        : value,
    )
    return { data, link }
  } catch {
    // A successful-but-unreadable POST can still have produced a remote effect.
    throw new GitHubRequestError(
      status,
      attempted && method !== 'GET' && (status === undefined || status >= 500 || (status >= 200 && status < 300)),
      retryAt,
    )
  }
}
