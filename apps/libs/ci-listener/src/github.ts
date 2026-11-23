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
    readonly rateLimited = false,
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
  response?: 'json' | 'empty' | 'no-content' | 'page'
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
    if (!response.ok) retryAt = await githubErrorRetryAt(response)
    if (!response.ok || options.response === 'empty' || options.response === 'no-content') {
      await response.body?.cancel()
      if (!response.ok || (options.response === 'no-content' && status !== 204))
        throw new Error('GitHub HTTP acknowledgement is not definitive')
      return undefined
    }
    const link = response.headers.get('link')
    if (options.response === 'page' && link && Buffer.byteLength(link) > 8192) {
      await response.body?.cancel()
      throw new Error('GitHub pagination header limit')
    }
    const text = await readGitHubBody(response)
    if (options.response !== 'page') return JSON.parse(text)
    // Decimal IDs may change under Number#toString even when their binary value is exact.
    const data: unknown = JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
      typeof value === 'number' && !Number.isSafeInteger(value) && /^[1-9][0-9]*$/.test(context?.source ?? '')
        ? context!.source
        : value,
    )
    return { data, link }
  } catch (error) {
    if (
      method === 'GET' &&
      options.signal?.aborted &&
      (status === undefined || (status >= 200 && status < 300)) &&
      (error === options.signal.reason || (error instanceof Error && error.name === 'AbortError'))
    ) {
      throw options.signal.reason
    }
    // A successful-but-unreadable POST can still have produced a remote effect.
    throw new GitHubRequestError(
      status,
      attempted && method !== 'GET' && (status === undefined || status >= 500 || (status >= 200 && status < 300)),
      retryAt,
      retryAt !== undefined,
    )
  }
}

/** Report selected response fields only. GitHub messages can interpolate repository names, URLs and credentials. */
export async function githubErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const data: unknown = JSON.parse(await readGitHubBody(response, 8192))
    if (data === null || typeof data !== 'object' || !('message' in data) || typeof data.message !== 'string')
      return undefined
    if (/^API rate limit exceeded\b/i.test(data.message)) return 'API rate limit exceeded'
    if (/secondary rate limit/i.test(data.message)) return 'Secondary rate limit exceeded'
    if (['Bad credentials', 'Not Found', 'Resource not accessible by integration'].includes(data.message))
      return data.message
  } catch {
    /* A missing or unreadable error body does not change the observed status. */
  }
  return undefined
}

export async function githubErrorRetryAt(response: Response): Promise<number | undefined> {
  const fromHeaders = githubRetryAt(response)
  if (fromHeaders !== undefined || response.status !== 403) return fromHeaders
  return githubRetryAt(response, await githubErrorMessage(response))
}

export function githubRetryAt(response: Response, githubMessage?: string): number | undefined {
  let retryAt: number | undefined
  if (response.status === 403 || response.status === 429) {
    const after = response.headers.get('retry-after'),
      reset = response.headers.get('x-ratelimit-reset')
    if (after && /^\d{1,10}$/.test(after)) retryAt = Date.now() + Number(after) * 1000
    if (response.headers.get('x-ratelimit-remaining') === '0' && reset && /^\d{1,12}$/.test(reset))
      retryAt = Math.max(retryAt ?? 0, Number(reset) * 1000)
    const limited =
      response.status === 429 ||
      githubMessage === 'API rate limit exceeded' ||
      githubMessage === 'Secondary rate limit exceeded'
    if (limited && retryAt === undefined) retryAt = Date.now() + 60000
  }
  return retryAt
}

export async function readGitHubBody(response: Response, maxBytes = 1_048_576): Promise<string> {
  if (!response.body) throw new Error('Missing GitHub JSON response')
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel()
        throw new Error('GitHub response limit')
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}
